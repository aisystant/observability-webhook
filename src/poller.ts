// Pull-режим: опрос Better Stack API на новые incidents.
// Активирован после ArchGate β + обнаружения что free tier Better Stack
// не даёт outgoing webhooks (нужен платный $29/mo).
//
// Стратегия:
//   1. KV хранит last_seen_incident_id (cursor)
//   2. Cron каждую минуту: GET /api/v2/incidents?per_page=20
//   3. Фильтруем incidents с id > last_seen
//   4. Для каждого нового → format → sendTelegram
//   5. Update KV с max(id) среди увиденных
//
// При первом запуске (last_seen = null) — запоминаем текущий max, ничего не шлём
// (иначе бомбардировка старыми "Sample incident" примерами).

import type { BetterStackPayload } from "./format.js";

interface PollerEnv {
  OBSERVABILITY_STATE: KVNamespace;
  BETTERSTACK_API_TOKEN: string;
}

const KV_KEY_LAST_SEEN = "last_seen_incident_id";
// KV key prefix для tracking resolved-state каждого недавно увиденного incident
const KV_PREFIX_INC_STATE = "inc:";
// Сколько последних incidents отслеживаем для Resolved-перехода
// (KV writes на free 1k/day → каждый incident создаёт ~2 writes (Started, Resolved) = 500 incidents/day max)
const TRACK_RECENT_N = 50;

// Better Stack /api/v2/incidents response shape
interface BSIncident {
  id: string;
  type: string;
  attributes: {
    name?: string;
    url?: string;
    cause?: string;
    started_at?: string;
    acknowledged_at?: string | null;
    resolved_at?: string | null;
    response_status?: number;
    response_content?: string;
    [key: string]: unknown;
  };
}

interface BSIncidentsResponse {
  data: BSIncident[];
  pagination?: {
    next?: string | null;
  };
}

export interface PollResult {
  newIncidents: BetterStackPayload[];     // Started — впервые увидели
  resolvedIncidents: BetterStackPayload[]; // Resolved — перешли из Started в Resolved
  newLastSeenId: string | null;
  trackedUpdates: { id: string; resolved_at: string | null }[]; // для commit в KV
}

function toPayload(inc: BSIncident, statusOverride?: "Started" | "Resolved"): BetterStackPayload {
  const status = statusOverride ?? (inc.attributes.resolved_at ? "Resolved" : "Started");
  return {
    data: {
      id: inc.id,
      type: inc.type,
      attributes: {
        name: inc.attributes.name,
        url:
          inc.attributes.url ??
          `https://aisystant.betteruptime.com/incidents/${inc.id}`,
        cause: inc.attributes.cause,
        started_at: inc.attributes.started_at,
        acknowledged_at: inc.attributes.acknowledged_at,
        resolved_at: inc.attributes.resolved_at,
        status,
        severity: "medium", // Better Stack API не возвращает severity для incidents — baseline medium
        response_status: inc.attributes.response_status,
        response_content: inc.attributes.response_content,
      },
    },
  };
}

/**
 * Опрашивает Better Stack /incidents и определяет два класса событий:
 *   1. Started — incident впервые увиден (id > cursor)
 *   2. Resolved — incident, который мы раньше тречили как Started, теперь имеет resolved_at
 *
 * State в KV:
 *   - `last_seen_incident_id` — global cursor (max id среди всех увиденных)
 *   - `inc:{id}` — `{resolved_at: string|null}` для каждого недавно увиденного
 *
 * Для предотвращения роста KV (и расхода 1k writes/day на free):
 *   - Тречим только `TRACK_RECENT_N` последних incidents
 *   - После Resolved → удаляем `inc:{id}` из KV (история полная в Better Stack)
 */
export async function pollBetterStack(env: PollerEnv): Promise<PollResult> {
  const lastSeenStr = await env.OBSERVABILITY_STATE.get(KV_KEY_LAST_SEEN);
  const lastSeen = lastSeenStr ? BigInt(lastSeenStr) : null;

  const response = await fetch(
    `https://uptime.betterstack.com/api/v2/incidents?per_page=${TRACK_RECENT_N}`,
    {
      headers: { Authorization: `Bearer ${env.BETTERSTACK_API_TOKEN}` },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Better Stack API ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as BSIncidentsResponse;
  const incidents = json.data ?? [];

  if (incidents.length === 0) {
    return {
      newIncidents: [],
      resolvedIncidents: [],
      newLastSeenId: lastSeenStr,
      trackedUpdates: [],
    };
  }

  // Сортируем по id ASC
  const sorted = [...incidents].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : 1,
  );
  const maxIdSeen = BigInt(sorted[sorted.length - 1].id);

  // Bootstrap — первый запуск
  if (lastSeen === null) {
    return {
      newIncidents: [],
      resolvedIncidents: [],
      newLastSeenId: maxIdSeen.toString(),
      trackedUpdates: [],
    };
  }

  const newIncidents: BetterStackPayload[] = [];
  const resolvedIncidents: BetterStackPayload[] = [];
  const trackedUpdates: { id: string; resolved_at: string | null }[] = [];

  for (const inc of sorted) {
    const incId = BigInt(inc.id);
    const currentResolvedAt = inc.attributes.resolved_at ?? null;

    if (incId > lastSeen) {
      // Новый — впервые увидели
      if (currentResolvedAt) {
        // Если уже resolved при первом увиде (race condition между cron-runs) —
        // шлём оба сообщения подряд: Started + Resolved
        newIncidents.push(toPayload(inc, "Started"));
        resolvedIncidents.push(toPayload(inc, "Resolved"));
        trackedUpdates.push({ id: inc.id, resolved_at: currentResolvedAt });
      } else {
        newIncidents.push(toPayload(inc, "Started"));
        trackedUpdates.push({ id: inc.id, resolved_at: null });
      }
    } else {
      // Уже видели раньше — проверяем переход Started → Resolved
      const prevStateStr = await env.OBSERVABILITY_STATE.get(`${KV_PREFIX_INC_STATE}${inc.id}`);
      if (prevStateStr) {
        const prevState = JSON.parse(prevStateStr) as { resolved_at: string | null };
        if (prevState.resolved_at === null && currentResolvedAt !== null) {
          // Transition: был Started, стал Resolved
          resolvedIncidents.push(toPayload(inc, "Resolved"));
          trackedUpdates.push({ id: inc.id, resolved_at: currentResolvedAt });
        }
      }
    }
  }

  return {
    newIncidents,
    resolvedIncidents,
    newLastSeenId: maxIdSeen.toString(),
    trackedUpdates,
  };
}

export async function commitState(
  env: PollerEnv,
  newLastSeenId: string | null,
  trackedUpdates: { id: string; resolved_at: string | null }[],
): Promise<void> {
  if (newLastSeenId !== null) {
    await env.OBSERVABILITY_STATE.put(KV_KEY_LAST_SEEN, newLastSeenId);
  }
  for (const u of trackedUpdates) {
    if (u.resolved_at !== null) {
      // Resolved → удаляем из KV (история в Better Stack полная)
      await env.OBSERVABILITY_STATE.delete(`${KV_PREFIX_INC_STATE}${u.id}`);
    } else {
      // Started → запоминаем
      await env.OBSERVABILITY_STATE.put(
        `${KV_PREFIX_INC_STATE}${u.id}`,
        JSON.stringify({ resolved_at: null }),
      );
    }
  }
}
