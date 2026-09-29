import { ReminderJobMetricsBinder } from './reminder-metrics';
import {
  getReminderJobMetricQuery,
  resetReminderJobMetricQuery,
  REMINDER_JOB_GAUGE_SQL,
  type ReminderJobSample,
} from '../telemetry/app-metrics';

/**
 * NFR-9's metric seam (19-1): the binder must register the read on module
 * init and clear it on teardown — the gauges observe nothing (no series,
 * no wrong zero) when the module is absent, and a booted-then-destroyed
 * module must never leave a dangling closure over a dead pool.
 * The SQL contract is pinned too: pg_cron's own metadata only.
 */

jest.setTimeout(10_000);

const sample: ReminderJobSample = {
  succeeded: '2',
  failed: '1',
  age_seconds: '120',
};

/** A PgPoolFactory stand-in: withTransaction runs work on a stub client. */
const fakePool = (rows: ReminderJobSample[], fail = false) =>
  ({
    withTransaction: async (work) => {
      if (fail) throw new Error('pool gone');
      const client = { query: jest.fn().mockResolvedValue({ rows }) };
      return work(client);
    },
  }) as never;

beforeEach(() => {
  resetReminderJobMetricQuery();
});

afterEach(() => {
  resetReminderJobMetricQuery();
});

describe('ReminderJobMetricsBinder (NFR-9 seam)', () => {
  it('registers nothing before init — the gauges observe nothing', () => {
    expect(getReminderJobMetricQuery()).toBeNull();
  });

  it('onModuleInit registers a read routing through the pg pool transaction', async () => {
    const binder = new ReminderJobMetricsBinder(fakePool([sample]));
    binder.onModuleInit();
    const query = getReminderJobMetricQuery();
    expect(query).not.toBeNull();

    const rows = await query!(REMINDER_JOB_GAUGE_SQL);
    expect(rows).toEqual([sample]);
  });

  it('no rows at all resolves to an empty sample set (never-yet-run job)', async () => {
    const binder = new ReminderJobMetricsBinder(fakePool([]));
    binder.onModuleInit();
    const query = getReminderJobMetricQuery();
    expect(await query!(REMINDER_JOB_GAUGE_SQL)).toEqual([]);
  });

  it('onModuleDestroy clears the seam — no dangling closure over a dead pool', () => {
    const binder = new ReminderJobMetricsBinder(fakePool([]));
    binder.onModuleInit();
    expect(getReminderJobMetricQuery()).not.toBeNull();
    binder.onModuleDestroy();
    expect(getReminderJobMetricQuery()).toBeNull();
  });

  it('a failed read rejects — the gauge collector swallows and retries next tick', async () => {
    const binder = new ReminderJobMetricsBinder(fakePool([], true));
    binder.onModuleInit();
    const query = getReminderJobMetricQuery();
    await expect(query!(REMINDER_JOB_GAUGE_SQL)).rejects.toThrow('pool gone');
  });

  it('the pinned gauge SQL reads ONLY pg_cron metadata, counts bounded to 24 h, age to the 7-day prune', () => {
    expect(REMINDER_JOB_GAUGE_SQL).toContain('cron.job_run_details');
    // The reminders job is reached through cron.job — job_run_details has
    // NO jobname column (the real-DB hygiene probe caught the old
    // filter-on-run-details spelling erroring at every export tick).
    expect(REMINDER_JOB_GAUGE_SQL).toContain('job j on j.jobid = d.jobid');
    expect(REMINDER_JOB_GAUGE_SQL).toContain(
      "j.jobname = 'attendance-run-reminders'",
    );
    // The run counts ride the 24-hour window (filter, not table WHERE).
    expect(REMINDER_JOB_GAUGE_SQL).toContain("interval '24 hours'");
    // The age read rides the FULL prune-bounded window so a stopped job's
    // age grows instead of vanishing past 24 h (the audit's dead-gauge
    // window), and `having` keeps a never-run job exporting NO series
    // (an ungrouped aggregate would always answer one all-null row — the
    // audit's wrong-zero finding).
    expect(REMINDER_JOB_GAUGE_SQL).toContain("interval '7 days'");
    expect(REMINDER_JOB_GAUGE_SQL).toContain(
      'having max(d.end_time) is not null',
    );
    // The gauge never touches tenant tables (NFR-9's bounded read).
    expect(REMINDER_JOB_GAUGE_SQL).not.toMatch(
      /attendance_(records|attempts|enrolments)/,
    );
  });
});
