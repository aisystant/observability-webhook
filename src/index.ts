// WP-244 Ф4 — Observability Webhook → переключён на Pull-режим (25 апр 2026)
// see DP.SC.124 User-Facing Platform Health
// see DP.ROLE.035 Platform Observer (implementation E)
//
// Архитектурное решение pull vs push (25 апр 2026):
//   Better Stack free tier НЕ даёт outgoing webhooks (escalation policies = $29/mo).
//   Backup-план активирован: Cron Trigger каждую минуту опрашивает Better Stack API.
//   ArchGate β контракт сохранён: BS остаётся owner observability data, мы — pull consumer.
//   Latency push 5-15s → pull ~60-90s. Стоимость $29/mo → $0.
//   Возврат на push при upgrade — изменение 5 минут.

import { formatIncidentMessage, type BetterStackPayload } from "./format.js";
import { pollBetterStack, commitState } from "./poller.js";

interface Env {
  // [vars] из wrangler.toml
  TG_STATUS_CHANNEL: string;
  TG_TEAM_CHAT_IDS: string;
  MODE: "channel_only" | "team_only" | "both" | "off";
  WEBHOOK_HMAC_SECRET: string;
  MIN_SEVERITY_FOR_CHANNEL: "low" | "medium" | "high" | "critical";
  MIN_SEVERITY_FOR_TEAM: "low" | "medium" | "high" | "critical";
  // [secrets]
  TG_BOT_TOKEN: string;
  BETTERSTACK_API_TOKEN: string;
  // [kv]
  OBSERVABILITY_STATE: KVNamespace;
}

const SEVERITY_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // GET / — health check
    if (request.method === "GET" && url.pathname === "/") {
      const lastSeen = await env.OBSERVABILITY_STATE.get("last_seen_incident_id");
      return jsonResponse({
        ok: true,
        service: "observability-webhook",
        mode: "pull (cron polling)",
        last_seen_incident_id: lastSeen,
      });
    }

    // POST /poll — manual trigger (для smoke-test без ожидания cron)
    if (request.method === "POST" && url.pathname === "/poll") {
      try {
        const result = await runPollAndDispatch(env);
        return jsonResponse({ ok: true, ...result });
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    // POST /webhook — legacy push endpoint (оставлен для тестов через curl)
    if (request.method === "POST" && url.pathname === "/webhook") {
      return await handleWebhookPush(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  // Cron Trigger — основной production-путь
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runPollAndDispatch(env).catch((e) => {
        console.error("[poll] cron failed:", e instanceof Error ? e.message : String(e));
      }),
    );
  },
};

async function runPollAndDispatch(
  env: Env,
): Promise<{ started: number; resolved: number; sent: number; errors: string[] }> {
  if (env.MODE === "off") {
    return { started: 0, resolved: 0, sent: 0, errors: ["MODE=off"] };
  }

  const { newIncidents, resolvedIncidents, newLastSeenId, trackedUpdates } =
    await pollBetterStack(env);

  const allErrors: string[] = [];
  let sentCount = 0;

  // Started events первыми (естественный порядок)
  for (const payload of newIncidents) {
    const r = await dispatchPayload(env, payload);
    if (r.ok) sentCount++;
    allErrors.push(...r.errors);
  }
  // Resolved события — после Started
  for (const payload of resolvedIncidents) {
    const r = await dispatchPayload(env, payload);
    if (r.ok) sentCount++;
    allErrors.push(...r.errors);
  }

  // Commit cursor + per-incident state ПОСЛЕ отправки (at-least-once)
  await commitState(env, newLastSeenId, trackedUpdates);

  console.log(
    `[poll] started=${newIncidents.length} resolved=${resolvedIncidents.length} sent=${sentCount} errors=${allErrors.length} cursor=${newLastSeenId}`,
  );

  return {
    started: newIncidents.length,
    resolved: resolvedIncidents.length,
    sent: sentCount,
    errors: allErrors,
  };
}

async function dispatchPayload(
  env: Env,
  payload: BetterStackPayload,
): Promise<{ ok: boolean; errors: string[] }> {
  const message = formatIncidentMessage(payload);
  const severity = (payload.data?.attributes?.severity ?? "medium").toLowerCase();
  const severityRank = SEVERITY_RANK[severity] ?? 2;

  const errors: string[] = [];

  if (
    (env.MODE === "both" || env.MODE === "channel_only") &&
    env.TG_STATUS_CHANNEL &&
    severityRank >= (SEVERITY_RANK[env.MIN_SEVERITY_FOR_CHANNEL] ?? 2)
  ) {
    const r = await sendTelegram(env.TG_BOT_TOKEN, env.TG_STATUS_CHANNEL, message);
    if (!r.ok) errors.push(`channel ${env.TG_STATUS_CHANNEL}: ${r.error}`);
  }

  if (
    (env.MODE === "both" || env.MODE === "team_only") &&
    env.TG_TEAM_CHAT_IDS &&
    severityRank >= (SEVERITY_RANK[env.MIN_SEVERITY_FOR_TEAM] ?? 1)
  ) {
    const teamIds = env.TG_TEAM_CHAT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
    for (const chatId of teamIds) {
      const r = await sendTelegram(env.TG_BOT_TOKEN, chatId, message);
      if (!r.ok) errors.push(`team ${chatId}: ${r.error}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

async function handleWebhookPush(request: Request, env: Env): Promise<Response> {
  if (env.MODE === "off") {
    return jsonResponse({ ok: true, mode: "off", skipped: true });
  }
  if (!env.TG_BOT_TOKEN) {
    return jsonResponse({ error: "TG_BOT_TOKEN secret not configured" }, 500);
  }

  const rawBody = await request.text();

  if (env.WEBHOOK_HMAC_SECRET) {
    const sigHeader = request.headers.get("x-betterstack-signature");
    if (!sigHeader) return jsonResponse({ error: "missing signature" }, 401);
    const expected = await computeHmac(env.WEBHOOK_HMAC_SECRET, rawBody);
    if (!constantTimeEqual(sigHeader, expected)) {
      return jsonResponse({ error: "invalid signature" }, 403);
    }
  }

  let payload: BetterStackPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "invalid json" }, 400);
  }

  const result = await dispatchPayload(env, payload);
  return jsonResponse({
    ok: result.ok,
    errors: result.errors.length > 0 ? result.errors : undefined,
  });
}

async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `${response.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function computeHmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
