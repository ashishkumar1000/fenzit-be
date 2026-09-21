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
5. Deploy → Render builds the Dockerfile, then probes `/health` (2xx within 5s). Failed health checks within 15 min roll back the deploy.

## Environment variables

All required vars come from the joi boot-time validation in `src/app.module.ts` — the app refuses to start if any is missing.

| Var | Where the value comes from |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Project Settings → API / JWT settings |
| `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY`, `CLOUDFLARE_R2_BUCKET` | Cloudflare dashboard → R2 → Manage API tokens |
| `WORKER_WEBHOOK_SECRET` | Manually shared secret — must equal the value set on the `cloudflare-worker` side (wrangler secret) |
| `GOOGLE_PLACES_API_KEY` | Google Cloud console → APIs & Services → Credentials |

`NODE_ENV=production` is baked into the Dockerfile. Render injects `PORT` (default `10000`); `src/main.ts` binds `0.0.0.0:$PORT`.

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