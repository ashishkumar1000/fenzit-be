import { getAppMetrics } from './app-metrics';

/** Render's health check path — probed every few seconds; recording it
 * would drown real traffic in the metrics. */
const HEALTH_ROUTE = '/api/v1/health';

/**
 * Narrow structural types for the Fastify request/reply objects this module
 * touches. Deliberately NOT the full FastifyInstance/FastifyRequest types:
 * @nestjs/platform-fastify bundles its own copy of fastify, and registering
 * a plugin typed against the top-level `fastify` package fails to typecheck
 * against it. `addRequestMetricsHooks` is attached via
 * `app.getHttpAdapter().getInstance()` in main.ts instead of app.register.
 */
export interface MetricRequest {
  method: string;
  /** Route TEMPLATE, e.g. `/api/v1/customers/:id` (undefined on 404s). */
  routeOptions?: { url?: string };
  _metricsStart?: bigint;
}
export interface MetricReply {
  statusCode: number;
}

export interface MetricsHookTarget {
  addHook(
    type: 'onRequest',
    hook: (
      request: MetricRequest,
      reply: MetricReply,
      done: () => void,
    ) => void,
  ): unknown;
  addHook(
    type: 'onResponse',
    hook: (
      request: MetricRequest,
      reply: MetricReply,
      done: () => void,
    ) => void,
  ): unknown;
}

/**
 * Records one duration histogram sample per finished request (the
 * histogram's `_count` series serves as the request counter). Uses the
 * route TEMPLATE (e.g. `/api/v1/customers/:id`) as the `route` label —
 * never the raw URL — so metric cardinality stays bounded.
 *
 * CALLBACK-STYLE HOOKS, deliberately: on the freshly-resolved tree with
 * avvio 9.3.0 (the repo has no lockfile) every request hung on promise-style
 * hooks. package.json now overrides avvio to ~9.2.0 so the tree is healthy,
 * but that pin still depends on the override applying on every fresh
 * install — callback style works on both healthy and affected trees. Do not
 * convert these to async/await functions.
 *
 * Failures here must never disturb live traffic: the recording call is
 * wrapped, and the whole thing is a no-op when telemetry is disabled
 * (local dev, tests, CI — no OTLP endpoint configured).
 */
export function addRequestMetricsHooks(fastify: MetricsHookTarget): void {
  fastify.addHook('onRequest', (request, _reply, done) => {
    request._metricsStart = process.hrtime.bigint();
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    const metrics = getAppMetrics();
    const start = request._metricsStart;
    // No start time (hook ran before ours) or health probe → skip.
    if (
      !metrics ||
      start === undefined ||
      request.routeOptions?.url === HEALTH_ROUTE
    ) {
      done();
      return;
    }

    try {
      const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
      const route = request.routeOptions?.url ?? 'unmatched';
      metrics.recordHttpRequest(route, request.method, reply.statusCode, ms);
    } catch {
      // Telemetry must never break a live response — drop the sample.
    }
    done();
  });
}
