import type { Meter } from '@opentelemetry/api';
import { SMS_TEMPLATES } from '../common/constants/sms-templates';
import {
  DB_POOL_STATES,
  METRIC_DB_POOL_CONNECTIONS,
  METRIC_PUSH_MESSAGES,
  METRIC_REPORT_RENDER_DURATION,
  METRIC_REPORT_RENDERS,
  METRIC_SMS_DELIVERIES,
  getDomainMetrics,
  initDomainMetrics,
  resetDbPoolStats,
  resetDomainMetrics,
  setDbPoolStats,
  smsChannelLabel,
} from './domain-metrics';

/**
 * The domain-metrics recording path (2026-11-17 monitoring round). The
 * OTel SDK is stubbed at the meter — no provider, no exporter. The batch
 * callback must observe the pool's three states through the registered
 * seam, observe NOTHING for a missing/null/failed seam (no wrong zero,
 * never kills the export batch), and every record* call must land with the
 * labels the Grafana panels group by.
 */

interface CounterCall {
  metric: string;
  value: number;
  attributes?: Record<string, string>;
}
interface RecordCall {
  metric: string;
  value: number;
  attributes?: Record<string, string>;
}
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

/** A meter stub: captures counters, histograms and the batch callback. */
const stubMeter = (): {
  meter: Meter;
  callbacks: BatchCallback[];
  counterCalls: CounterCall[];
  recordCalls: RecordCall[];
} => {
  const callbacks: BatchCallback[] = [];
  const counterCalls: CounterCall[] = [];
  const recordCalls: RecordCall[] = [];
  const meter = {
    createCounter: (name: string) => ({
      add: (value: number, attributes?: Record<string, string>) =>
        counterCalls.push({ metric: name, value, attributes }),
    }),
    createHistogram: (name: string) => ({
      record: (value: number, attributes?: Record<string, string>) =>
        recordCalls.push({ metric: name, value, attributes }),
    }),
    createObservableGauge: (name: string) => ({ name }),
    addBatchObservableCallback: (cb: BatchCallback) => {
      callbacks.push(cb);
    },
  } as unknown as Meter;
  return { meter, callbacks, counterCalls, recordCalls };
};

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

beforeEach(() => {
  resetDbPoolStats();
  resetDomainMetrics();
});

afterEach(() => {
  resetDbPoolStats();
  resetDomainMetrics();
});

describe('initDomainMetrics', () => {
  it('creates the four recording instruments and one pool batch callback', () => {
    const { meter, callbacks, counterCalls, recordCalls } = stubMeter();
    initDomainMetrics(meter);
    expect(callbacks).toHaveLength(1);
    // Instruments exist (record paths are asserted below); no recording
    // has happened yet.
    expect(counterCalls).toEqual([]);
    expect(recordCalls).toEqual([]);
    expect(getDomainMetrics()).not.toBeNull();
  });

  it('recordSms counts one delivery with the channel and outcome labels', () => {
    const capturing = stubMeter();
    initDomainMetrics(capturing.meter);
    getDomainMetrics()?.recordSms('otp', 'ok');
    getDomainMetrics()?.recordSms('invite', 'timeout');
    expect(capturing.counterCalls).toEqual([
      {
        metric: METRIC_SMS_DELIVERIES,
        value: 1,
        attributes: { channel: 'otp', outcome: 'ok' },
      },
      {
        metric: METRIC_SMS_DELIVERIES,
        value: 1,
        attributes: { channel: 'invite', outcome: 'timeout' },
      },
    ]);
  });

  it('recordPush counts one message with the outcome label', () => {
    const capturing = stubMeter();
    initDomainMetrics(capturing.meter);
    getDomainMetrics()?.recordPush('unregistered');
    expect(capturing.counterCalls).toEqual([
      {
        metric: METRIC_PUSH_MESSAGES,
        value: 1,
        attributes: { outcome: 'unregistered' },
      },
    ]);
  });

  it('recordReportRender counts the run and records the duration histogram', () => {
    const capturing = stubMeter();
    initDomainMetrics(capturing.meter);
    getDomainMetrics()?.recordReportRender('attendance', 'ok', 4.2);
    getDomainMetrics()?.recordReportRender('attendance', 'error', 1.5);
    expect(capturing.counterCalls).toEqual([
      {
        metric: METRIC_REPORT_RENDERS,
        value: 1,
        attributes: { template: 'attendance', outcome: 'ok' },
      },
      {
        metric: METRIC_REPORT_RENDERS,
        value: 1,
        attributes: { template: 'attendance', outcome: 'error' },
      },
    ]);
    expect(capturing.recordCalls).toEqual([
      {
        metric: METRIC_REPORT_RENDER_DURATION,
        value: 4.2,
        attributes: { template: 'attendance' },
      },
      {
        metric: METRIC_REPORT_RENDER_DURATION,
        value: 1.5,
        attributes: { template: 'attendance' },
      },
    ]);
  });

  it('resetDomainMetrics unpublishes the registry (recordings become no-ops)', () => {
    initDomainMetrics(stubMeter().meter);
    resetDomainMetrics();
    expect(getDomainMetrics()).toBeNull();
    expect(() => getDomainMetrics()?.recordSms('otp', 'ok')).not.toThrow();
  });
});

describe('the DB pool gauges', () => {
  it('observes the three pool states through the registered seam', async () => {
    const { meter, callbacks } = stubMeter();
    initDomainMetrics(meter);
    setDbPoolStats(() => ({ total: 5, idle: 3, waiting: 1 }));

    const seen = await runBatch(callbacks);
    expect(seen).toEqual(
      DB_POOL_STATES.map((state) => ({
        gauge: METRIC_DB_POOL_CONNECTIONS,
        value: { total: 5, idle: 3, waiting: 1 }[state],
        attributes: { state },
      })),
    );
  });

  it('no seam registered → the callback observes nothing (module absent)', async () => {
    const { meter, callbacks } = stubMeter();
    initDomainMetrics(meter);
    expect(await runBatch(callbacks)).toEqual([]);
  });

  it('a null snapshot (pool ended) observes NOTHING — no wrong zero', async () => {
    const { meter, callbacks } = stubMeter();
    initDomainMetrics(meter);
    setDbPoolStats(() => null);
    expect(await runBatch(callbacks)).toEqual([]);
  });

  it('a failed seam observes NOTHING and never throws into the batch', async () => {
    const { meter, callbacks } = stubMeter();
    initDomainMetrics(meter);
    setDbPoolStats(() => {
      throw new Error('pool gone');
    });
    await expect(runBatch(callbacks)).resolves.toEqual([]);
  });
});

describe('smsChannelLabel', () => {
  it('maps the code-constant template IDs to friendly channels', () => {
    expect(smsChannelLabel(SMS_TEMPLATES.OTP_LOGIN)).toBe('otp');
    expect(smsChannelLabel(SMS_TEMPLATES['T-INVITE'])).toBe('invite');
    expect(smsChannelLabel('anything-else')).toBe('other');
  });

  it('EVERY registered SMS template maps to a friendly channel — no silent "other" (review F1 tripwire)', () => {
    // sms-templates.ts re-registers a changed template under a NEW ID; a
    // new ID that lands here without a mapping case would silently drop
    // that channel's Grafana series into 'other'.
    for (const id of Object.values(SMS_TEMPLATES)) {
      expect(smsChannelLabel(id)).not.toBe('other');
    }
  });
});
