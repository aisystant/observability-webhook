// Форматирование сообщений из Better Stack webhook payload в TG MarkdownV2.
// Структура payload — Better Stack incident webhook (см. https://betterstack.com/docs/uptime/webhooks/).

export interface BetterStackPayload {
  data?: {
    id?: string;
    type?: string;
    attributes?: {
      name?: string;
      url?: string;
      cause?: string;
      started_at?: string;
      acknowledged_at?: string | null;
      resolved_at?: string | null;
      status?: "Started" | "Acknowledged" | "Resolved" | string;
      severity?: "low" | "medium" | "high" | "critical" | string;
      response_content?: string;
      response_status?: number;
    };
  };
  // Better Stack может расширять поля
  [key: string]: unknown;
}

const STATUS_EMOJI: Record<string, string> = {
  started: "\u{1F534}",        // 🔴
  acknowledged: "\u{1F7E1}",   // 🟡
  resolved: "\u{1F7E2}",       // 🟢
};

const STATUS_LABEL: Record<string, string> = {
  started: "Инцидент",
  acknowledged: "В работе",
  resolved: "Восстановлено",
};

const SEVERITY_LABEL: Record<string, string> = {
  low: "низкий",
  medium: "средний",
  high: "высокий",
  critical: "критический",
};

export function formatIncidentMessage(payload: BetterStackPayload): string {
  const attr = payload.data?.attributes ?? {};
  const status = (attr.status ?? "Started").toLowerCase();
  const emoji = STATUS_EMOJI[status] ?? "⚪"; // ⚪ fallback
  const label = STATUS_LABEL[status] ?? "Событие";
  const severity = SEVERITY_LABEL[(attr.severity ?? "medium").toLowerCase()] ?? "средний";
  const monitorName = attr.name ?? "сервис";
  const cause = attr.cause ?? attr.response_content?.slice(0, 200) ?? "";
  const startedAt = attr.started_at ? formatTime(attr.started_at) : "";
  const resolvedAt = attr.resolved_at ? formatTime(attr.resolved_at) : "";
  const url = attr.url ?? "";

  const lines: string[] = [];

  // Шапка
  lines.push(`${emoji} *${escape(label)}* — ${escape(monitorName)}`);

  // Severity (только если не Resolved)
  if (status !== "resolved") {
    lines.push(`Серьёзность: ${escape(severity)}`);
  }

  // Время
  if (status === "resolved" && startedAt && resolvedAt) {
    const durationMin = computeDurationMinutes(attr.started_at!, attr.resolved_at!);
    lines.push(`Длительность: ${durationMin} мин \\(${escape(startedAt)} → ${escape(resolvedAt)}\\)`);
  } else if (startedAt) {
    lines.push(`Начало: ${escape(startedAt)}`);
  }

  // Причина (внутри backticks MarkdownV2 экранирует только ` и \)
  if (cause && status !== "resolved") {
    lines.push("");
    lines.push(`Причина: \`${escapeCode(cause)}\``);
  }

  // URL мониторинга — статус-страница (Better Stack default до custom domain)
  const STATUS_PAGE_URL = "https://aisystant.betteruptime.com";
  lines.push("");
  if (url) {
    lines.push(`[Подробнее](${url})`);
  } else {
    lines.push(`[Все инциденты](${STATUS_PAGE_URL})`);
  }

  return lines.join("\n");
}

function formatTime(iso: string): string {
  // Преобразует ISO в "ЧЧ:ММ МСК" (московское время)
  try {
    const d = new Date(iso);
    const moscow = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
    const hh = moscow.getHours().toString().padStart(2, "0");
    const mm = moscow.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm} МСК`;
  } catch {
    return iso;
  }
}

function computeDurationMinutes(startIso: string, endIso: string): number {
  try {
    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();
    return Math.max(1, Math.round((end - start) / 60000));
  } catch {
    return 0;
  }
}

// MarkdownV2 escape — обязательные символы для TG
const MD_V2_ESCAPE = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escape(s: string): string {
  return s.replace(MD_V2_ESCAPE, "\\$&");
}

// Inside inline code `...`: только ` и \ нужно эскейпить
function escapeCode(s: string): string {
  return s.replace(/[`\\]/g, "\\$&");
}
