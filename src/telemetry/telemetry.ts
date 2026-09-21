import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
// OTel v2: Resource instances come from the factory (the class is type-only).
import { resourceFromAttributes } from '@opentelemetry/resources';
import { parseOtlpHeaders } from './otlp-headers';
import { initAppMetrics, resetAppMetrics } from './app-metrics';
import { initRuntimeMetrics, shutdownRuntimeMetrics } from './runtime-metrics';

/**
 * Grafana Cloud telemetry (metrics only), pushed over OTLP/HTTP protobuf.
 *
 * Disabled entirely unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so local
 * dev, tests and CI never touch the network. The two required variables
 * come from the Grafana Cloud portal (OpenTelemetry tile) and are stored
 * as secrets in the Render dashboard:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT  e.g. https://otlp-gateway-prod-ap-south-1.grafana.net/otlp
 *   - OTEL_EXPORTER_OTLP_HEADERS   e.g. Authorization=Basic <base64>
 *
 * Auto-instrumentation is deliberately NOT used: it relies on require
 * hooks that Bun does not support. Request metrics come from the Fastify
 * plugin, runtime gauges from runtime-metrics.ts.
 *
 * This module must never crash the app: init failures are logged and
 * telemetry stays off (see initTelemetry).
 */
const logger = new Logger('Telemetry');

let provider: MeterProvider | null = null;

export function isTelemetryEnabled(): boolean {
  // Standard OTel kill switch — wins even when an endpoint is configured,
  // so a stray endpoint in CI or a shared dev machine can be silenced.
  if (process.env['OTEL_SDK_DISABLED']?.trim() === 'true') return false;
  // Production-only: local dev, tests and CI never export metrics, even
  // when the endpoint vars are present in .env (e.g. copied over from the
  // Grafana Cloud setup for testing).
  if (process.env['NODE_ENV'] !== 'production') return false;
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  return Boolean(endpoint && /^https?:\/\//.test(endpoint));
}

/** Idempotent, never throws. Returns true when telemetry started. */
export async function initTelemetry(): Promise<boolean> {
  if (provider) return true;
  if (!isTelemetryEnabled()) return false;

  try {
    const endpoint = (process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '')
      .trim()
      .replace(/\/+$/, '');
    const headers = parseOtlpHeaders(process.env['OTEL_EXPORTER_OTLP_HEADERS']);
    if (Object.keys(headers).length === 0) {
      // Most likely misconfiguration — exports would 401 every interval,
      // visible only in diag-level logs. Warn loudly at boot instead.
      logger.warn(
        'OTEL_EXPORTER_OTLP_ENDPOINT is set but OTEL_EXPORTER_OTLP_HEADERS is empty or unparsable — exports will fail auth. Copy BOTH values from the Grafana Cloud OpenTelemetry tile.',
      );
    }
    const intervalMs = parseIntervalMs(process.env['OTEL_EXPORT_INTERVAL_MS']);

    // Surface export failures (bad token, network errors) — without a diag
    // logger the SDK drops failed batches silently.
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

    const exporter = new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
      headers,
      timeoutMillis: 10_000,
    });
    provider = new MeterProvider({
      resource: resourceFromAttributes(buildResourceAttributes()),
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: intervalMs,
        }),
      ],
    });

    const meter = provider.getMeter('fenzit.telemetry');
    initAppMetrics(meter);
    initRuntimeMetrics(meter);

    logger.log(`Metrics export to Grafana Cloud every ${intervalMs}ms`);
    return true;
  } catch (err) {
    logger.error(
      'Failed to start telemetry — continuing without metrics',
      err instanceof Error ? err.stack : String(err),
    );
    // Tear down whatever was built: a half-initialised provider keeps its
    // export timer ticking, and a published registry keeps recording into
    // it (samples that would never be exported).
    await shutdownTelemetry();
    resetAppMetrics();
    return false;
  }
}

/** Flushes and stops the exporter. Safe to call when telemetry is off. */
export async function shutdownTelemetry(): Promise<void> {
  shutdownRuntimeMetrics();
  const current = provider;
  provider = null;
  await current?.shutdown({ timeoutMillis: 10_000 });
}

function parseIntervalMs(raw: string | undefined): number {
  const parsed = Number(raw ?? 30_000);
  // Clamp to [1s, 1h]: a 1ms interval hammers the Grafana gateway, a huge
  // one means metrics effectively never land.
  if (!Number.isFinite(parsed) || parsed < 1_000 || parsed > 3_600_000) {
    return 30_000;
  }
  return parsed;
}

/**
 * Resource attributes identifying this service in Grafana. Render exposes
 * the deployed commit as RENDER_GIT_COMMIT — mapping it to service.version
 * lets dashboards separate deploys.
 */
function buildResourceAttributes(): Record<string, string> {
  const attributes: Record<string, string> = {
    'service.name': 'fenzit-be',
    'deployment.environment.name': process.env['NODE_ENV'] ?? 'development',
  };
  const commit = process.env['RENDER_GIT_COMMIT'];
  if (commit) attributes['service.version'] = commit.slice(0, 7);
  return attributes;
}

/**
 * Nest lifecycle hook — registered as a provider in AppModule. Runs after
 * Nest has closed the HTTP server on SIGTERM, so the final flush includes
 * everything recorded during the drain.
 */
@Injectable()
export class TelemetryShutdown implements OnApplicationShutdown {
  // Awaited: Nest waits for onApplicationShutdown before finishing close(),
  // so the final batch actually flushes inside Render's 30s grace window
  // (the 10s shutdown timeout bounds the wait).
  async onApplicationShutdown(): Promise<void> {
    try {
      await shutdownTelemetry();
    } catch (err: unknown) {
      logger.error(
        'Telemetry shutdown failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
