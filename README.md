# observability-webhook

Cloudflare Worker — receiver для Better Stack incident webhook → постит уведомления в TG-канал и/или DM команде.

**Назначение:** реализация DP.ROLE.035 Platform Observer implementation E (см. [DP.ROLE.035](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.ROLE.035-platform-observer.md) и [DP.SC.124 User-Facing Platform Health](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.124-user-facing-platform-health.md)).

**Тип репозитория:** DS/instrument (CF Worker, аналог event-gateway).

**Родительский РП:** [WP-244 Platform Observability](../../DS-my-strategy/inbox/WP-244-platform-observability.md) Ф4.

**ArchGate:** β зафиксирован 25 апр 2026 (см. WP-244 context).

---

## Зачем отдельный CF Worker, а не handler в aist-bot

Webhook нужен **именно в момент**, когда aist-bot может быть упавшим (это и есть основной use-case observability). Если положить handler внутрь Python-процесса бота, при его падении алерт не доходит до пользователей.

CF Worker:
- Использует тот же `TG_BOT_TOKEN` AIST_me_bot, но стучится напрямую в `api.telegram.org/bot{TOKEN}/sendMessage`.
- Не зависит от aist-bot Python процесса (тот может быть down).
- Кросс-зависимость только с TG API (если упал TG — не доходит никому, и это нормально, мы это не починим).

---

## Архитектура

```
Better Stack incident detected (3+ fail подряд из probes)
        │
        │ POST webhook (HMAC signed)
        ▼
┌────────────────────────────────────────┐
│ observability-webhook (CF Worker)      │
│  ├ Verify HMAC                         │
│  ├ Parse Better Stack payload          │
│  ├ Format на русском (MarkdownV2)      │
│  └ Distribute по env.MODE:             │
│     - channel (public, для пользов.)  │
│     - team DM (критические команде)   │
└────────────────────┬───────────────────┘
                     │ POST api.telegram.org/sendMessage
                     ▼
        ┌────────────────────────┐
        │ Telegram API (внешний) │
        └────────┬───────────────┘
                 │
        ┌────────┼───────────────┐
        ▼        ▼               ▼
   @aisystant_  @aist_me_bot DM   (опц. email — настраивается
   status        команде          в Better Stack subscriptions)
```

---

## Конфигурация

### `wrangler.toml` vars

| Var | Что | Пример |
|-----|-----|--------|
| `TG_STATUS_CHANNEL` | TG-канал для пользователей (public broadcast) | `@aisystant_status` или `-1001234567890` |
| `TG_TEAM_CHAT_IDS` | Chat IDs команды через запятую (DM) | `12345,67890` |
| `MODE` | `channel_only` / `team_only` / `both` / `off` | `both` |
| `WEBHOOK_HMAC_SECRET` | HMAC от Better Stack для верификации (опц.) | пустой = выкл |
| `MIN_SEVERITY_FOR_CHANNEL` | low/medium/high/critical | `medium` |
| `MIN_SEVERITY_FOR_TEAM` | low/medium/high/critical | `low` |

### Secrets (через `wrangler secret put`)

- `TG_BOT_TOKEN` — токен бота AIST_me_bot (из `.secrets/`)

```bash
wrangler secret put TG_BOT_TOKEN
# Запросит ввод — вставить токен из .secrets/
```

---

## Endpoints

### `GET /` — health check

Используется как Better Stack monitor (один из 5-7 сервисов в DP.SC.123 §Архитектура).

```bash
curl https://obs-webhook.aisystant.com/
# {"ok":true,"service":"observability-webhook"}
```

### `POST /webhook` — main endpoint

Принимает Better Stack webhook payload. Если задан HMAC — верифицирует. Форматирует, шлёт.

---

## Smoke test

```bash
# Локально:
npm install
npm run dev  # wrangler dev

# Тест-запрос (имитация Better Stack):
curl -X POST http://localhost:8787/webhook \
  -H "content-type: application/json" \
  -d '{
    "data": {
      "id": "test-1",
      "attributes": {
        "name": "event-gateway",
        "url": "https://uptime.betterstack.com/incidents/test-1",
        "cause": "HTTP 503",
        "started_at": "2026-04-25T17:00:00Z",
        "status": "Started",
        "severity": "high"
      }
    }
  }'
# Ожидание: пост в @aisystant_status (если настроен) + DM команде
```

---

## Deploy

```bash
# 1. Установить зависимости
npm install

# 2. Настроить vars в wrangler.toml (TG_STATUS_CHANNEL, TG_TEAM_CHAT_IDS, MODE)

# 3. Положить secret
wrangler secret put TG_BOT_TOKEN

# 4. Deploy
npm run deploy

# 5. Получить URL
# wrangler выдаст URL вида https://observability-webhook.<your>.workers.dev

# 6. Прописать этот URL в Better Stack:
#    Better Stack → Notifications → Webhook integration → URL = ...
#    Better Stack → Notifications → Add webhook secret (опц., paste в WEBHOOK_HMAC_SECRET)
```

---

## Формат сообщения (на русском)

**Started:**
```
🔴 Инцидент — event-gateway
Серьёзность: высокий
Начало: 17:00 МСК

Причина: `HTTP 503`

Подробнее на status.aisystant.ru
```

**Resolved:**
```
🟢 Восстановлено — event-gateway
Длительность: 12 мин (17:00 МСК → 17:12 МСК)

Все инциденты на status.aisystant.ru
```

---

## Связи

- **Обещание:** [DP.SC.124 User-Facing Platform Health](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.124-user-facing-platform-health.md)
- **Роль:** [DP.ROLE.035 Platform Observer](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.ROLE.035-platform-observer.md) implementation E
- **Родительский РП:** [WP-244](../../DS-my-strategy/inbox/WP-244-platform-observability.md) Ф4
- **Соседние Workers** (для контекста): event-gateway (DP.ROLE.032), gateway-mcp, knowledge-mcp, digital-twin-mcp, personal-knowledge-mcp.
