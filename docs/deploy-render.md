# Deploying fenzit-be to Render

Docker deployment via [Render](https://render.com). Config lives in three files:

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build: bun install/build → bun-slim runtime (`bun dist/src/main.js`) |
| `.dockerignore` | Keeps the build context small; excludes `.env*` so secrets never enter the image |
| `render.yaml` | Render Blueprint (service definition + env vars) |

## First deploy

1. Push this repo to GitHub.
2. Render dashboard → **New +** → **Blueprint** → pick the `fenzit-be` repo.
3. Render reads `render.yaml` (runtime `docker`, region `singapore`, plan `starter`, health check `/health`).
4. Render prompts once for each `sync: false` env var — see the table below. Values are stored as secrets.
5. Deploy → Render builds the Dockerfile, then probes `/api/v1/health` (2xx within 5s). Failed health checks within 15 min roll back the deploy.

Note: for a service provisioned from this blueprint, the live health-check path is what the Render dashboard holds (Settings → Health Check Path). If it was created before `render.yaml` set `/api/v1/health`, update the dashboard setting too — an unprefixed `/health` probe 404s and fails deploys.

## Environment variables

All required vars come from the joi boot-time validation in `src/app.module.ts` — the app refuses to start if any is missing.

| Var | Where the value comes from |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Project Settings → API / JWT settings |
| `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY`, `CLOUDFLARE_R2_BUCKET` | Cloudflare dashboard → R2 → Manage API tokens |
| `WORKER_WEBHOOK_SECRET` | Manually shared secret — must equal the value set on the `cloudflare-worker` side (wrangler secret) |
| `GOOGLE_PLACES_API_KEY` | Google Cloud console → APIs & Services → Credentials |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | Grafana Cloud portal → your stack → OpenTelemetry tile (optional — metrics export only when the endpoint is set **and** `NODE_ENV=production`; local dev, tests and CI never export, and `OTEL_SDK_DISABLED=true` also turns telemetry off) |
| `OTEL_EXPORT_INTERVAL_MS` | Optional export cadence in ms, default `30000`; values outside 1s–1h fall back to the default |

`NODE_ENV=production` is baked into the Dockerfile. Render injects `PORT` (default `10000`); `src/main.ts` binds `0.0.0.0:$PORT`.

### Grafana metrics (src/telemetry/)

When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the backend pushes metrics to Grafana Cloud over OTLP/HTTP every 30s (tunable via `OTEL_EXPORT_INTERVAL_MS`; values outside 1s–1h fall back to 30s). What it exports — names below are the Prometheus series names after the OTLP→Prometheus conversion appends unit suffixes:

- `http_server_request_duration_seconds` (histogram; the `_count` series is the request counter) per `http.route` template + method + status — Render health probes are excluded. Measured from Fastify's `onRequest` hook, so it excludes socket/parse time before the hook. Requests that match no route (404s, scanner traffic) aggregate under `route="unmatched"`.
- Runtime gauges: `process_memory_rss_bytes`, `process_memory_heap_used_bytes` (bytes) and `node_eventloop_delay_seconds` (collected in ms, converted to seconds by the conversion). Confirm the exact series names in Grafana Explore before building dashboards.

On SIGTERM the final batch is flushed via the `TelemetryShutdown` lifecycle provider (registered in `src/app.module.ts`) after the HTTP server closes. Export failures (e.g. expired token) are logged at error level via the OTel diag logger — if Grafana shows no data, check Render logs first. A boot warning about empty headers means `OTEL_EXPORTER_OTLP_HEADERS` was not set alongside the endpoint — exports will 401 until both values from the portal are set.

## Deploy lifecycle

- **Auto-deploys**: every push to `main` triggers a build + deploy (`autoDeploy: true`).
- **Graceful shutdown**: Render sends SIGTERM on deploys/scale-downs; `enableShutdownHooks()` + `forceCloseConnections: 'idle'` (in `src/main.ts`) drain in-flight requests within Render's 30s grace window.
- **`runtime`, `type`, `region` are immutable** after service creation — changing them needs a new service.

## Local smoke test

```sh
docker build -t fenzit-be .
docker run --rm -p 3000:3000 --env-file .env fenzit-be
curl http://localhost:3000/api/v1/health
```

Note: locally `.env` sets `PORT=3000`, so the container listens on 3000. On Render, `PORT=10000` (injected).