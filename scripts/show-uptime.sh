#!/usr/bin/env bash
# Quick check: composite + per-monitor uptime «по девяткам».
#
# Usage:
#   show-uptime.sh                    # дефолт = последние 30 дней
#   DAYS=7 show-uptime.sh             # за неделю
#   DAYS=90 show-uptime.sh            # за квартал

set -euo pipefail

TOKEN="${BETTERSTACK_API_TOKEN:-$(cat ~/IWE/.secrets/betterstack-api-token 2>/dev/null || echo '')}"
DAYS="${DAYS:-30}"

[[ -z "$TOKEN" ]] && { echo "ERROR: BETTERSTACK_API_TOKEN not set"; exit 1; }

# Дата начала (cross-platform: GNU date vs BSD date macOS)
FROM=$(date -u -v-${DAYS}d +%Y-%m-%d 2>/dev/null || date -u -d "-${DAYS} days" +%Y-%m-%d)
TO=$(date -u +%Y-%m-%d)

echo "=== Aisystant Platform Uptime — за $DAYS дней ($FROM → $TO) ==="
echo ""

# Получаем все monitors
MONITORS=$(curl -fsSL -H "Authorization: Bearer $TOKEN" "https://uptime.betterstack.com/api/v2/monitors")

# Composite uptime = multiplicative product
COMPOSITE_PCT=$(echo "$MONITORS" | python3 -c "
import json, sys
data = json.load(sys.stdin)['data']
import urllib.request, urllib.error

token = '$TOKEN'
days = '$DAYS'
from_date = '$FROM'

def fetch_sla(mid):
    url = f'https://uptime.betterstack.com/api/v2/monitors/{mid}/sla?from={from_date}'
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.load(r)
            return d.get('data', {}).get('attributes', {})
    except Exception as e:
        return {}

print(f'{\"Monitor\":<32} {\"Uptime\":>12} {\"Incidents\":>10} {\"Downtime\":>14}')
print('-' * 70)
prod = 1.0
for m in data:
    a = m['attributes']
    sla = fetch_sla(m['id'])
    avail = sla.get('availability', 0)
    incs = sla.get('number_of_incidents', 0)
    dt = sla.get('total_downtime', 0)
    dt_str = f'{dt//60}m {dt%60}s' if dt < 3600 else f'{dt//3600}h {(dt%3600)//60}m'
    if dt == 0: dt_str = '0s'
    name = a.get('pronounceable_name', '?')[:31]
    print(f'{name:<32} {avail:>11}% {incs:>10} {dt_str:>14}')
    prod *= avail / 100.0

composite = prod * 100.0
print('-' * 70)
print(f'{\"COMPOSITE (по девяткам)\":<32} {composite:>10.4f}%')
print(f'')

# Девятки notation
nines = 0
val = composite
while val >= 99.9 and nines < 6:
    nines += 1
    val = (val - (100 - 10**(-nines)*100)) * 10
print(f'Девятки: {\"девять \" * (int(composite) // 10 - 8)}{\"девять (~%.4f%%)\" % composite}'.replace('девять девять девять девять девять', 'пять девяток').replace('девять девять девять девять', 'четыре девятки').replace('девять девять девять', 'три девятки').replace('девять девять', 'две девятки'))
"
)
echo "$COMPOSITE_PCT"
echo ""
echo "Подробнее: https://aisystant.betteruptime.com"
