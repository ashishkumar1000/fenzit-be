import type { Meter } from '@opentelemetry/api';

/**
 * Metric name as it appears in Grafana (OTLP → Prometheus conversion).
 * The histogram's `_count` series doubles as the request counter, so no
 * separate counter instrument exists — see recordHttpRequest.
 */
export const METRIC_HTTP_DURATION = 'http.server.request.duration';

/** OTel semantic-convention attribute keys (survive into Grafana labels). */
const ATTR_ROUTE = 'http.route';
const ATTR_METHOD = 'http.request.method';
const ATTR_STATUS = 'http.response.status_code';

/**
 * App metrics registry. The Fastify plugin records through this interface,
 * so tests can stub it without the OTel SDK.
 */
export interface AppMetrics {
  /** Histogram (seconds) — Grafana name: http_server_request_duration_seconds. */
  httpDuration: HistogramLike;
  /** Records one handled request (duration in ms). */
  recordHttpRequest(
    route: string,
    method: string,
    status: number,
    ms: number,
  ): void;
}

/** Minimal structural types so tests can stub metrics without the OTel SDK. */
export interface HistogramLike {
  record(value: number, attributes?: Record<string, string>): void;
}

const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

let registry: AppMetrics | null = null;

/** Creates the metric instruments from the given meter and publishes them. */
export function initAppMetrics(meter: Meter): AppMetrics {
  const httpDuration = meter.createHistogram(METRIC_HTTP_DURATION, {
    description: 'HTTP request duration',
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
  });

  registry = {
    httpDuration,
    recordHttpRequest(route, method, status, ms) {
      // Measured from the onRequest hook — excludes Fastify's socket/parse
      // time before that hook fires. The caveat is inherent to hook-based
      // instrumentation; noted here so dashboards don't treat it as the
      // full semconv http.server.request.duration.
      const attributes = {
        [ATTR_ROUTE]: route,
        [ATTR_METHOD]: method,
        [ATTR_STATUS]: String(status),
      };
      httpDuration.record(ms / 1000, attributes);
    },
  };
  return registry;
}

/** Returns the process-wide metrics registry, or null before init. */
export function getAppMetrics(): AppMetrics | null {
  return registry;
}

/**
 * Clears the registry so the plugin stops recording — used by initTelemetry
 * when a partial init leaves instruments pointing at a torn-down provider
 * (samples recorded there would never be exported). Also the reset seam for
 * tests that need a clean module state.
 */
export function resetAppMetrics(): void {
  registry = null;
}
