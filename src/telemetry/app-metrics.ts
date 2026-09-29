import { Logger } from '@nestjs/common';
import type { Meter } from '@opentelemetry/api';

/**
 * Metric name as it appears in Grafana (OTLP → Prometheus conversion).
 * The histogram's `_count` series doubles as the request counter, so no
 * separate counter instrument exists — see recordHttpRequest.
 */
export const METRIC_HTTP_DURATION = 'http.server.request.duration';

/** NFR-9 (19-1): the reminder job's run counts, by status, last 24 h. */
export const METRIC_REMINDER_JOB_RUNS = 'attendance.reminder_job.runs';
/** NFR-9 (19-1): seconds since the job's last finished run (stops → grows). */
export const METRIC_REMINDER_JOB_LAST_AGE =
  'attendance.reminder_job.last_run_age_seconds';

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

/**
 * NFR-9's reminder-job metrics (19-1): two ObservableGauges over pg_cron's
 * own run log (`cron.job_run_details`, pruned past 7 days by the same
 * story's cron-job-run-details-cleanup job — the read stays bounded by
 * design). The gauges observe at EXPORT time — one tiny SELECT per export
 * tick, no timer in the web service (AD-14) and no run-log table (AD-26);
 * this resolves spine line 510's open decision (user-ratified 2026-09-29).
 *
 * The DB seam is a registered callback rather than an initAppMetrics
 * argument: telemetry boots before the Nest DI container (main.ts), so the
 * pg pool cannot be handed in — attendance's ReminderJobMetricsBinder
 * registers it from onModuleInit instead, and the gauge callback reads the
 * latest setter each tick. No rows → the gauges observe nothing (a never-yet-
 * run job exports no series rather than a wrong zero); a failed read skips
 * the tick (the next export retries).
 */
export interface ReminderJobSample {
  succeeded: string;
  failed: string;
  age_seconds: string | null;
}
export type ReminderJobQueryFn = (
  sql: string,
) => Promise<ReminderJobSample[]>;

let reminderJobQuery: ReminderJobQueryFn | null = null;

/** Registers the read that the reminder-job gauges poll at export time. */
export function setReminderJobMetricQuery(
  query: ReminderJobQueryFn,
): void {
  reminderJobQuery = query;
}

/** Clears the seam (telemetry teardown and the tests' reset seam). */
export function resetReminderJobMetricQuery(): void {
  reminderJobQuery = null;
}

const logger = new Logger('AppMetrics');

/** Reads the current seam registration (diagnostics + the binder spec). */
export function getReminderJobMetricQuery(): ReminderJobQueryFn | null {
  return reminderJobQuery;
}

/**
 * The reminder gauges' single-row read (exported: the binder spec pins it).
 * The job is reached THROUGH cron.job — job_run_details has no jobname
 * column (the real-DB hygiene probe caught an older filter spelling that
 * never joined, erroring at every export tick).
 *
 * The two windows differ by design: the run COUNTS ride a 24-hour window;
 * the age read deliberately rides the FULL prune-bounded window (7 days —
 * the same story's prune job keeps the input bounded), so a stopped job's
 * age GROWS instead of vanishing once the last run ages past 24 h (the
 * 24-hour filter would drop it and silence the very scenario the gauge
 * exists to alert on). `having max(d.end_time) is not null` keeps the
 * never-yet-run contract honest — an ungrouped aggregate would otherwise
 * always return one all-null row and the gauges would export a 0/0 series
 * for a job that has never run (a never-run job exports NO series, per
 * the audit).
 */
export const REMINDER_JOB_GAUGE_SQL = `select
    count(*) filter (
      where d.status = 'succeeded'
        and d.start_time > now() - interval '24 hours') as succeeded,
    count(*) filter (
      where d.status = 'failed'
        and d.start_time > now() - interval '24 hours') as failed,
    extract(epoch from (now() - max(d.end_time)))  as age_seconds
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
  where j.jobname = 'attendance-run-reminders'
    and d.start_time > now() - interval '7 days'
  having max(d.end_time) is not null`;

/**
 * One export-tick read: polls the registered query and hands the sample to
 * the two gauge observers. The SDK awaits the batch callback before
 * recording the batch, so a still-pending read cannot dangle.
 */
async function collectReminderJobSample(
  observeRuns: (value: number, status: string) => void,
  observeAge: (value: number) => void,
): Promise<void> {
  const query = reminderJobQuery;
  if (!query) return;
  try {
    const rows = await query(REMINDER_JOB_GAUGE_SQL);
    const sample = rows[0];
    if (!sample) return;
    observeRuns(Number(sample.succeeded ?? 0), 'succeeded');
    observeRuns(Number(sample.failed ?? 0), 'failed');
    if (sample.age_seconds != null) observeAge(Number(sample.age_seconds));
  } catch (err) {
    // The exporter must never kill a batch over one gauge; the next tick
    // retries. The failure is logged (the audit's silent-catch finding):
    // pg_cron records failed runs itself, but a dead pool here is OUR
    // defect and must show in the service logs. No coordinates ride this
    // path (NFR-9/11 — tenant ids only, and none even here).
    logger.warn('Reminder-job gauge read failed; retrying next export tick', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Creates the metric instruments from the given meter and publishes them. */
export function initAppMetrics(meter: Meter): AppMetrics {
  const httpDuration = meter.createHistogram(METRIC_HTTP_DURATION, {
    description: 'HTTP request duration',
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
  });

  // NFR-9 (19-1): the reminder-job gauges ride the same batch export —
  // addBatchObservableCallback observes both instruments at every metric
  // export tick. The run-count gauge carries the status attribute; the
  // age gauge is unlabelled.
  const reminderRuns = meter.createObservableGauge(METRIC_REMINDER_JOB_RUNS, {
    description:
      'attendance_run_reminders pg_cron runs in the last 24 h, by status',
    unit: '{run}',
  });
  const reminderLastAge = meter.createObservableGauge(
    METRIC_REMINDER_JOB_LAST_AGE,
    {
      description:
        'Seconds since the last finished attendance-run-reminders run',
      unit: 's',
    },
  );
  meter.addBatchObservableCallback(
    (result) =>
      collectReminderJobSample(
        (value, status) =>
          result.observe(reminderRuns, value, {
            'cron.job.status': status,
          }),
        (value) => result.observe(reminderLastAge, value),
      ),
    [reminderRuns, reminderLastAge],
  );

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
