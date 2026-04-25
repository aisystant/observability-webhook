#!/usr/bin/env bash
#
# WP-244 Митигация L2.6 — Quarterly export Better Stack snapshot.
#
# Запуск: руками или через ритуал /month-close в первый Пн квартала
# (январь / апрель / июль / октябрь).
#
# Источник: ArchGate β L2 «Сохранность знаний» — observability history
# в Better Stack теряется при смене SaaS. Этот скрипт делает квартальный
# JSON-snapshot композитного uptime, инцидент-таймлайна, агрегатов latency.
#
# see DP.SC.123 §«Митигация L2.6 Сохранность знаний»

set -euo pipefail

# ─── Конфигурация ─────────────────────────────────────────────────────────────

# Better Stack API token (https://uptime.betterstack.com/team/api/tokens)
# Лучше через env: BETTERSTACK_API_TOKEN=... ./quarterly-export.sh
BETTERSTACK_API_TOKEN="${BETTERSTACK_API_TOKEN:-}"

# Куда складывать JSON-снимки (создаётся при необходимости)
OUTPUT_DIR="${OUTPUT_DIR:-$HOME/IWE/DS-ecosystem-development/0.OPS/0.99.Archive/observability-snapshots}"

# Период экспорта (по умолчанию — текущий квартал)
QUARTER="${QUARTER:-$(date +%Y)-Q$(( ($(date +%m) - 1) / 3 + 1 ))}"

# ─── Проверки ─────────────────────────────────────────────────────────────────

if [[ -z "$BETTERSTACK_API_TOKEN" ]]; then
    echo "ERROR: BETTERSTACK_API_TOKEN not set." >&2
    echo "  Получи токен: https://uptime.betterstack.com/team/api/tokens" >&2
    echo "  Запуск: BETTERSTACK_API_TOKEN=ust_xxx $0" >&2
    exit 2
fi

mkdir -p "$OUTPUT_DIR"

OUTFILE="$OUTPUT_DIR/${QUARTER}.json"

if [[ -f "$OUTFILE" ]]; then
    echo "WARN: $OUTFILE уже существует. Перезаписать? [y/N]"
    read -r answer
    [[ "$answer" == "y" || "$answer" == "Y" ]] || exit 0
fi

# ─── Сбор данных через Better Stack API ───────────────────────────────────────

API="https://uptime.betterstack.com/api/v2"
H_AUTH="Authorization: Bearer $BETTERSTACK_API_TOKEN"

echo "=== Quarterly snapshot $QUARTER → $OUTFILE ==="

# 1. Список monitors с composite SLA
MONITORS=$(curl -fsSL -H "$H_AUTH" "$API/monitors" | jq '.data')

# 2. Инциденты за квартал (берём за последние 90 дней)
INCIDENTS=$(curl -fsSL -H "$H_AUTH" "$API/incidents?from=$(date -v-90d -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -d '-90 days' -u +%Y-%m-%dT%H:%M:%SZ)" | jq '.data')

# 3. SLA для каждого monitor (последние 90 дней)
# Better Stack API может возвращать SLA per monitor — проверь актуальную доку
SLA_REPORTS="[]"
for monitor_id in $(echo "$MONITORS" | jq -r '.[].id'); do
    sla=$(curl -fsSL -H "$H_AUTH" "$API/monitors/$monitor_id/sla?from=$(date -v-90d -u +%Y-%m-%d 2>/dev/null || date -d '-90 days' -u +%Y-%m-%d)" 2>/dev/null || echo '{}')
    SLA_REPORTS=$(echo "$SLA_REPORTS" | jq ". + [{\"monitor_id\": \"$monitor_id\", \"sla\": $sla}]")
done

# Composite uptime — собираем из SLA reports
COMPOSITE=$(echo "$SLA_REPORTS" | jq '[.[] | .sla.data.attributes.availability // null | numbers] | if length > 0 then (reduce .[] as $u (1; . * ($u / 100))) * 100 else null end')

# ─── Финальный JSON ───────────────────────────────────────────────────────────

jq -n \
    --arg quarter "$QUARTER" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson monitors "$MONITORS" \
    --argjson incidents "$INCIDENTS" \
    --argjson sla "$SLA_REPORTS" \
    --argjson composite "$COMPOSITE" \
    '{
        quarter: $quarter,
        generated_at: $generated_at,
        composite_uptime_pct: $composite,
        monitors: $monitors,
        incidents: $incidents,
        sla_per_monitor: $sla
    }' > "$OUTFILE"

echo ""
echo "✓ Snapshot сохранён: $OUTFILE"
echo "  Размер: $(wc -c < "$OUTFILE" | tr -d ' ') bytes"
echo "  Monitors: $(echo "$MONITORS" | jq 'length')"
echo "  Incidents за 90d: $(echo "$INCIDENTS" | jq 'length')"
echo "  Composite uptime: $(echo "$COMPOSITE" | jq -r 'if . then (. * 1000 | round / 1000 | tostring + \"%\") else \"n/a\" end')"

# ─── Опционально: commit в git ───────────────────────────────────────────────

if [[ -d "$(dirname "$OUTPUT_DIR")/.git" ]] && command -v git >/dev/null; then
    cd "$(dirname "$OUTPUT_DIR")"
    git add "$OUTFILE" 2>/dev/null || true
    echo ""
    echo "Файл добавлен в git staging. Коммит сделай вручную:"
    echo "  cd $(dirname "$OUTPUT_DIR") && git commit -m \"observability: quarterly snapshot $QUARTER\""
fi
