import type { Meter } from '@opentelemetry/api';

/**
 * Domain + dependency metrics (2026-11-17 monitoring round) — the surfaces
 * the HTTP request histogram CANNOT see:
 *  - outbound SMS deliveries (MSG91) split by channel and outcome — an
 *    invite-SMS rejection never fails its HTTP request, so without a
 *    counter it is invisible;
 *  - FCM push message outcomes (the push sweep runs in the background);
 *  - PDF report renders (the report worker runs in the background — and
 *    renders are the process's memory spike risk);
 *  - DB pool saturation (a starved 5-connection pool shows up first here,
 *    minutes before any request times out).
 *
 * Same registry pattern as app-metrics.ts: instruments created from the
 * telemetry meter, a structural interface published for call sites, and a
 * registered callback seam for a dependency (the pool) that cannot be
 * handed in at init time (telemetry boots before the DI container).
 */

/** MSG91 delivery outcome — mirrors SmsDeliveryError's outcome kinds. */
export type SmsOutcome = 'ok' | 'error' | 'timeout';
/** FCM per-message outcome — mirrors PushSendError's action kinds. */
export type PushOutcome =
  | 'ok'
  | 'unregistered'
  | 'invalid'
  | 'retryable'
  | 'permanent';
/** Report render outcome (the pipeline's two terminal states). */
export type ReportOutcome = 'ok' | 'error';

export const METRIC_SMS_DELIVERIES = 'fenzit.sms.deliveries';
export const METRIC_PUSH_MESSAGES = 'fenzit.push.messages';
export const METRIC_REPORT_RENDERS = 'fenzit.reports.renders';
export const METRIC_REPORT_RENDER_DURATION = 'fenzit.reports.render.duration';
export const METRIC_DB_POOL_CONNECTIONS = 'db.pool.connections';

/** The pool gauges' one state label — three series per process. */
export const DB_POOL_STATES = ['total', 'idle', 'waiting'] as const;
export type DbPoolState = (typeof DB_POOL_STATES)[number];

export interface DbPoolStats {
  total: number;
  idle: number;
  waiting: number;
}

/**
 * App-facing recording surface. Every method is a no-op safe call site:
 * callers reach for getDomainMetrics() and `?.` — recording into a torn-
 * down registry (local dev, tests, shutdown) records nothing.
 */
export interface DomainMetrics {
  /** One MSG91 template delivery. `channel` labels otp / invite / other. */
  recordSms(channel: string, outcome: SmsOutcome): void;
  /** One FCM message result (recorded per message, not per batch). */
  recordPush(outcome: PushOutcome): void;
  /** One report pipeline run, success or failure, with its wall duration. */
  recordReportRender(
    template: string,
    outcome: ReportOutcome,
    seconds: number,
  ): void;
}

/** Renders take seconds-to-minutes (25k-row grids), not milliseconds. */
const RENDER_BUCKETS_SECONDS = [1, 2.5, 5, 10, 15, 30, 60, 120];

let registry: DomainMetrics | null = null;
let poolStatsProvider: (() => DbPoolStats | null) | null = null;

/** Registers the pool snapshot the DB-pool gauges poll at export time. */
export function setDbPoolStats(
  provider: () => DbPoolStats | null,
): void {
  poolStatsProvider = provider;
}

/** Clears the seam (telemetry teardown and the tests' reset seam). */
export function resetDbPoolStats(): void {
  poolStatsProvider = null;
}

/**
 * Maps a DLT template ID onto the friendly channel label. Template IDs are
 * code constants (sms-templates.ts), so the mapping is exhaustive for the
 * templates that exist; an unmapped ID degrades to 'other' instead of
 * inventing a high-cardinality label.
 */
export function smsChannelLabel(templateId: string): string {
  switch (templateId) {
    case '6abbb9d03a3773ee7209dd94': // SMS_TEMPLATES.OTP_LOGIN
      return 'otp';
    case 'PENDING_DLT_APPROVAL': // SMS_TEMPLATES['T-INVITE'] placeholder
      return 'invite';
    default:
      return 'other';
  }
}

/**
 * Creates the instruments from the given meter and publishes the registry.
 * The pool gauges ride one batch callback that polls the registered seam —
 * a missing seam (module not loaded) observes nothing; a seam that returns
 * null (pool ended) observes nothing rather than a wrong zero.
 */
export function initDomainMetrics(meter: Meter): DomainMetrics {
  const smsDeliveries = meter.createCounter(METRIC_SMS_DELIVERIES, {
    description: 'MSG91 SMS template deliveries by channel and outcome',
  });
  const pushMessages = meter.createCounter(METRIC_PUSH_MESSAGES, {
    description: 'FCM push message outcomes (background sweep traffic)',
  });
  const reportRenders = meter.createCounter(METRIC_REPORT_RENDERS, {
    description: 'Report pipeline runs by template and outcome',
  });
  const reportRenderDuration = meter.createHistogram(
    METRIC_REPORT_RENDER_DURATION,
    {
      description: 'Report render wall duration (fetch → upload → stamp)',
      unit: 's',
      advice: { explicitBucketBoundaries: RENDER_BUCKETS_SECONDS },
    },
  );
  const poolGauge = meter.createObservableGauge(METRIC_DB_POOL_CONNECTIONS, {
    description: 'pg pool connections by state (total / idle / waiting)',
    unit: '{connection}',
  });
  meter.addBatchObservableCallback(
    (result) => {
      const provider = poolStatsProvider;
      if (!provider) return;
      let stats: DbPoolStats | null = null;
      try {
        stats = provider();
      } catch {
        // A dead pool must not kill the export batch — the next tick
        // retries. No coordinates ride this path.
        return;
      }
      if (!stats) return;
      result.observe(poolGauge, stats.total, { state: 'total' });
      result.observe(poolGauge, stats.idle, { state: 'idle' });
      result.observe(poolGauge, stats.waiting, { state: 'waiting' });
    },
    [poolGauge],
  );

  registry = {
    recordSms(channel, outcome) {
      smsDeliveries.add(1, { channel, outcome });
    },
    recordPush(outcome) {
      pushMessages.add(1, { outcome });
    },
    recordReportRender(template, outcome, seconds) {
      reportRenders.add(1, { template, outcome });
      reportRenderDuration.record(seconds, { template });
    },
  };
  return registry;
}

/** Returns the process-wide domain registry, or null before init. */
export function getDomainMetrics(): DomainMetrics | null {
  return registry;
}

/** Clears the registry — telemetry teardown and the tests' reset seam. */
export function resetDomainMetrics(): void {
  registry = null;
}
