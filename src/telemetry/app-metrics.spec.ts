import { Logger } from '@nestjs/common';
import type { Meter } from '@opentelemetry/api';
import {
  METRIC_REMINDER_JOB_LAST_AGE,
  METRIC_REMINDER_JOB_RUNS,
  initAppMetrics,
  resetAppMetrics,
  resetReminderJobMetricQuery,
  setReminderJobMetricQuery,
  type ReminderJobSample,
} from './app-metrics';

/**
 * The NFR-9 observation path (19-1). Written as a tester: the batch
 * callback registered on init must EXECUTE at export time — map the
 * sample onto the two gauges (the run-count gauge labelled by
 * 'cron.job.status'), export nothing for a never-run job (no wrong zero),
 * skip a null age, and swallow a failed read with a LOGGED warning (the
 * silent-catch finding) so a dead pool shows in the service logs. The OTel
 * SDK is stubbed at the meter — no provider, no exporter.
 */

jest.setTimeout(10_000);

interface Observation {
  gauge: string;
  value: number;
  attributes?: Record<string, string>;
}

type BatchCallback = (result: {
  observe(
    instrument: object,
    value: number,
    attributes?: Record<string, string>,
  ): void;
}) => void | Promise<void>;

/** A meter stub: captures the gauges and the registered batch callback. */
const stubMeter = (): {
  meter: Meter;
  callbacks: BatchCallback[];
} => {
  const callbacks: BatchCallback[] = [];
  const meter = {
    createHistogram: () => ({ record: jest.fn() }),
    createObservableGauge: (name: string) => ({ name }),
    addBatchObservableCallback: (cb: BatchCallback) => {
      callbacks.push(cb);
    },
  } as unknown as Meter;
  return { meter, callbacks };
};

/**
 * Runs the registered batch callback once and collects its observations.
 * AWAITS the callback — the SDK contract is "await the batch callback
 * before recording the batch" (collectReminderJobSample's read is async;
 * a harness that forgets to await models no real export tick).
 */
const runBatch = async (callbacks: BatchCallback[]): Promise<Observation[]> => {
  const seen: Observation[] = [];
  await callbacks[0]({
    observe(instrument, value, attributes) {
      seen.push({
        gauge: (instrument as { name: string }).name,
        value,
        attributes,
      });
    },
  });
  return seen;
};

const sample: ReminderJobSample = {
  succeeded: '2',
  failed: '1',
  age_seconds: '120',
};

const fakeSeam = (rows: ReminderJobSample[], fail = false) =>
  jest.fn(async () => {
    if (fail) throw new Error('pool gone');
    return rows;
  });

beforeEach(() => {
  resetReminderJobMetricQuery();
  resetAppMetrics();
});

afterEach(() => {
  resetReminderJobMetricQuery();
  resetAppMetrics();
});

describe('initAppMetrics — the reminder-job gauges (NFR-9, 19-1)', () => {
  it('registers the two gauges and one batch callback at init', () => {
    const { meter, callbacks } = stubMeter();
    initAppMetrics(meter);
    expect(callbacks).toHaveLength(1);
  });

  it('observes the sample at export: run counts by status label, then the age', async () => {
    const { meter, callbacks } = stubMeter();
    const query = fakeSeam([sample]);
    setReminderJobMetricQuery(query);
    initAppMetrics(meter);

    const seen = await runBatch(callbacks);
    expect(seen).toEqual([
      {
        gauge: METRIC_REMINDER_JOB_RUNS,
        value: 2,
        attributes: { 'cron.job.status': 'succeeded' },
      },
      {
        gauge: METRIC_REMINDER_JOB_RUNS,
        value: 1,
        attributes: { 'cron.job.status': 'failed' },
      },
      { gauge: METRIC_REMINDER_JOB_LAST_AGE, value: 120 },
    ]);
    // The read rode the export tick — the pinned gauge SQL goes through.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('cron.job_run_details');
  });

  it('a null age observes the run counts but NO age (null stays unobserved)', async () => {
    const { meter, callbacks } = stubMeter();
    setReminderJobMetricQuery(
      fakeSeam([{ ...sample, age_seconds: null }]),
    );
    initAppMetrics(meter);

    const seen = await runBatch(callbacks);
    expect(seen.map((o) => o.gauge)).toEqual([
      METRIC_REMINDER_JOB_RUNS,
      METRIC_REMINDER_JOB_RUNS,
    ]);
  });

  it('no rows (never-run job) → NOTHING observed — no series, no wrong zero', async () => {
    const { meter, callbacks } = stubMeter();
    setReminderJobMetricQuery(fakeSeam([]));
    initAppMetrics(meter);

    expect(await runBatch(callbacks)).toEqual([]);
  });

  it('no seam registered → the callback observes nothing (module absent)', async () => {
    const { meter, callbacks } = stubMeter();
    initAppMetrics(meter);

    expect(await runBatch(callbacks)).toEqual([]);
  });

  it('a failed read observes NOTHING and logs a warning — never kills the batch', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { meter, callbacks } = stubMeter();
    setReminderJobMetricQuery(fakeSeam([], true));
    initAppMetrics(meter);

    expect(await runBatch(callbacks)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('gauge read failed');
    warnSpy.mockRestore();
  });
});
