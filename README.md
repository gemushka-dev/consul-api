# Consul API (`consul-api-ts`)

Бэкенд платформы **Consul** (TypeScript + Express + Vercel Neon PostgreSQL + Drizzle ORM + Vercel Upstash Redis).

## Стек

- **Runtime & Framework:** Node.js 20+, TypeScript (`strict: true`), Express 5
- **Database:** Vercel Neon PostgreSQL (`@neondatabase/serverless`) + Drizzle ORM
  - `DATABASE_URL` (pooled `-pooler`) — для runtime-запросов
  - `DIRECT_URL` (direct) — для миграций (`npm run db:migrate`)
- **Cache & Rate Limiting:** Vercel Upstash Redis (`@upstash/redis`, `@upstash/ratelimit`)
  - OTP-хеши (TTL 5 мин) и блокировка после 3 попыток (10 мин)
  - Blacklist отозванных `refresh_token`
  - Кэш идемпотентности `Idempotency-Key` (`idem:${userId}:${key}`, TTL 24 ч)
  - Кэш TTS-аудио (`tts:${sha256}`, TTL 24 ч)
- **AI & Media:** Moonshot **Kimi K3** (`https://api.moonshot.ai/v1`, OpenAI SDK, `AI_THINKING=enabled` с сохранением `reasoning_content` при multi-step tool calling + нативный vision), **ElevenLabs** STT (`scribe_v1`) и TTS (`eleven_flash_v2_5`) с 24ч кэшем в Upstash Redis, `multer` (`memoryStorage`)
- **Docs:** OpenAPI 3.0.3 (`src/docs/openapi.yaml`) + Swagger UI на `/api/docs`

## Быстрый старт

1. Скопируйте переменные окружения и заполните ключи Neon, Upstash, JWT, AI и VoiceLab:
   ```bash
   cp .env.example .env
   ```
2. Установите зависимости:
   ```bash
   npm install
   ```
3. Накатите миграции БД (через `DIRECT_URL`):
   ```bash
   npm run db:migrate
   ```
4. Засейте эталонный демо-аккаунт Дилнозы (`free = 4 200 000`) и панель Палаты (812 предпринимателей):
   ```bash
   npm run seed:demo
   npm run seed:palata
   ```
5. Запустите сервер разработки:
   ```bash
   npm run dev
   ```
   - API v1: `http://localhost:3000/api/v1`
   - Swagger UI: `http://localhost:3000/api/docs`
   - Health / Readiness: `http://localhost:3000/api/v1/healthz`, `http://localhost:3000/api/v1/readyz`

## Проверки и тесты

```bash
npm run typecheck   # строгая проверка TypeScript
npm run build       # сборка в dist/
npm test            # unit-тесты и полный E2E smoke-тест питча (in-memory PGlite Postgres)
```
