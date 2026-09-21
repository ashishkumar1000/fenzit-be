export {
  initTelemetry,
  shutdownTelemetry,
  isTelemetryEnabled,
  TelemetryShutdown,
} from './telemetry';
export { addRequestMetricsHooks } from './fastify-metrics.plugin';
export { getAppMetrics } from './app-metrics';
export { parseOtlpHeaders } from './otlp-headers';
