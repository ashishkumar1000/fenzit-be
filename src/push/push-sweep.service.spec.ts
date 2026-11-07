import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import type { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { JOB_ASSIGNED_EVENT } from '../jobs/job-notifications';
import { NoopPushSender } from './noop-push-sender';
import type { PushMessage, PushSendOutcome } from './push-sender.port';
import { PushSender } from './push-sender.port';
import { PushSweepService } from './push-sweep.service';

const TENANT_A = 'f9d5ca79-a245-4a0d-9393-e4a2af718885';
const TENANT_B = '11111111-2222-4333-8444-555555555555';
const USER_1 = '0f5e6d7c-8a9b-4c0d-8e1f-2a3b4c5d6e7f';
const USER_2 = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const JOB_ID = 'e0d0a690-92b7-4617-aadb-364e6139156b';

interface Row {
  id: string;
  tenant_id: string;
  user_id: string;
  job_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  entity_type: string | null;
  entity_id: string | null;
}

interface Lookup {
  user_id: string;
  tenant_id: string;
  token: string;
}

/**
 * Fake pg client: routes each statement by its SQL text so the sweep's
 * real queries run against scripted rows. The tenant guard itself is SQL —
 * these tests cover what the TS does with the rows it gets back.
 */
function fakePg(script: {
  claim: Row[];
  lookup?: Lookup[];
  claimError?: Error;
}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('for update skip locked')) {
      if (script.claimError) throw script.claimError;
      return { rows: script.claim };
    }
    if (sql.includes('from unnest($1::uuid[], $2::uuid[])')) {
      return { rows: script.lookup ?? [] };
    }
    return { rows: [] };
  });
  const tx = { query } as unknown as PoolClient;
  const pg = {
    withTransaction: jest.fn((fn: (c: PoolClient) => Promise<unknown>) =>
      fn(tx),
    ),
  } as unknown as PgPoolFactory;
  return { pg, calls };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: over.id ?? 'n-1',
    tenant_id: TENANT_A,
    user_id: USER_1,
    job_id: JOB_ID,
    event_type: JOB_ASSIGNED_EVENT,
    payload: { job_number: 'JB-2026-0002', customer_name: 'Asha' },
    entity_type: null,
    entity_id: null,
    ...over,
  };
}

function config(values: Record<string, number> = {}): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

/** Sender double: each call answers with the scripted outcomes (or all-ok). */
class ScriptedSender extends PushSender {
  readonly sendEach = jest.fn(
    async (messages: PushMessage[]): Promise<PushSendOutcome[]> =>
      messages.map((message) => ({ message, error: null })),
  );
}

function tick(service: PushSweepService): Promise<void> {
  return (service as unknown as { tick(): Promise<void> }).tick();
}

describe('PushSweepService', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('lifecycle', () => {
    it('never arms the interval with the noop provider', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const { pg } = fakePg({ claim: [] });
      const service = new PushSweepService(pg, new NoopPushSender(), config());

      service.onModuleInit();

      expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it('arms the interval for a real sender and clears it on destroy', () => {
      jest.useFakeTimers();
      const { pg } = fakePg({ claim: [] });
      const service = new PushSweepService(
        pg,
        new ScriptedSender(),
        config({ PUSH_SWEEP_INTERVAL_SECONDS: 5 }),
      );

      service.onModuleInit();
      expect(jest.getTimerCount()).toBe(1);

      service.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('claim', () => {
    it('claims with the configured max age and the batch cap', async () => {
      const { pg, calls } = fakePg({ claim: [] });
      const service = new PushSweepService(
        pg,
        new ScriptedSender(),
        config({ PUSH_MAX_AGE_MINUTES: 30 }),
      );

      await tick(service);

      const claim = calls.find((c) => c.sql.includes('for update skip locked'));
      expect(claim?.params).toEqual([30, 100]);
    });

    it('does no token lookup and no send when nothing is claimed', async () => {
      const { pg, calls } = fakePg({ claim: [] });
      const sender = new ScriptedSender();
      await tick(new PushSweepService(pg, sender, config()));

      expect(calls.some((c) => c.sql.includes('unnest($1::uuid[]'))).toBe(false);
      expect(sender.sendEach).not.toHaveBeenCalled();
    });

    it('logs a failed claim and does not throw (additive sweep)', async () => {
      const { pg } = fakePg({
        claim: [],
        claimError: new Error('connection reset'),
      });
      const service = new PushSweepService(pg, new ScriptedSender(), config());

      await expect(tick(service)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('a failed tick releases the running guard so the next tick still works', async () => {
      // A stuck `running` flag would silently stop every future sweep. The
      // same service runs a failing tick, then a healthy one.
      const script: {
        claim: Row[];
        lookup: Lookup[];
        claimError?: Error;
      } = {
        claim: [],
        lookup: [{ user_id: USER_1, tenant_id: TENANT_A, token: 'tok-1' }],
        claimError: new Error('boom'),
      };
      const { pg } = fakePg(script);
      const sender = new ScriptedSender();
      const service = new PushSweepService(pg, sender, config());
      await tick(service);

      delete script.claimError;
      script.claim = [row()];
      await tick(service);

      expect(sender.sendEach).toHaveBeenCalledTimes(1);
    });

    it('does not start a second tick while one is still running', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const sender = new ScriptedSender();
      sender.sendEach.mockImplementationOnce(async (messages) => {
        await gate;
        return messages.map((message) => ({ message, error: null }));
      });
      const { pg, calls } = fakePg({
        claim: [row()],
        lookup: [{ user_id: USER_1, tenant_id: TENANT_A, token: 'tok-1' }],
      });
      const service = new PushSweepService(pg, sender, config());

      const first = tick(service);
      await tick(service); // overlapping tick: must return immediately
      release();
      await first;

      expect(
        calls.filter((c) => c.sql.includes('for update skip locked')),
      ).toHaveLength(1);
    });
  });

  describe('fan-out to tokens', () => {
    it('sends one message per token with type + job id in data', async () => {
      const { pg } = fakePg({
        claim: [row()],
        lookup: [
          { user_id: USER_1, tenant_id: TENANT_A, token: 'tok-a' },
          { user_id: USER_1, tenant_id: TENANT_A, token: 'tok-b' },
        ],
      });
      const sender = new ScriptedSender();
      await tick(new PushSweepService(pg, sender, config()));

      const sent = sender.sendEach.mock.calls[0][0];
      expect(sent.map((m) => m.token)).toEqual(['tok-a', 'tok-b']);
      expect(sent[0].data).toEqual({ type: JOB_ASSIGNED_EVENT, id: JOB_ID });
      expect(sent[0].title).toBe('New job assigned');
      expect(sent[0].channel).toBe('fenzit_jobs');
      expect(sent[0].visibility).toBe('PUBLIC');
    });

    it('uses entity_id as the data id when there is no job id', async () => {
      const { pg } = fakePg({
        claim: [
          row({
            job_id: null,
            entity_id: 'report-9',
            event_type: 'report_ready',
          }),
        ],
        lookup: [{ user_id: USER_1, tenant_id: TENANT_A, token: 'tok-a' }],
      });
      const sender = new ScriptedSender();
      await tick(new PushSweepService(pg, sender, config()));

      expect(sender.sendEach.mock.calls[0][0][0].data).toEqual({
        type: 'report_ready',
        id: 'report-9',
      });
    });

    it('omits the data id when neither job nor entity id exists', async () => {
      const { pg } = fakePg({
        claim: [row({ job_id: null, entity_id: null, event_type: 'mystery.event', payload: {} })],
        lookup: [{ user_id: USER_1, tenant_id: TENANT_A, token: 'tok-a' }],
      });
      const sender = new ScriptedSender();
      await tick(new PushSweepService(pg, sender, config()));

      expect(sender.sendEach.mock.calls[0][0][0].data).toEqual({
        type: 'mystery.event',
      });
    });

    it('dedupes a token repeated by the lookup: one message per token per row', async () => {
      const { pg } = fakePg({
        claim: [row({ id: 'n-1' })],
        lookup: [
          { user_id: USER_1, tenant_id: TENANT_A, token: 'tok-a' },
          { user_id: USER_1, tenant_id: TENANT_A, token: 'tok-a' },
        ],
      });
      const sender = new ScriptedSender();
      await tick(new PushSweepService(pg, sender, config()));

      expect(sender.sendEach.mock.calls[0][0]).toHaveLength(1);
    });

    it('three rows for one recipient with two tokens = six messages, not eighteen', async () => {
      const { pg } = fakePg({
        claim: [row({ id: 'n-1' }), row({ id: 'n-2' }), row({ id: 'n-3' })],
        lookup: [
          { user_id: USER_1, tenant_id: TENANT_A, token: 'tok-a' },
          { user_id: USER_1, tenant_id: TENANT_A, token: 'tok-b' },
        ],
      });
      const sender = new ScriptedSender();
      await tick(new PushSweepService(pg, sender, config()));

      expect(sender.sendEach.mock.calls[0][0]).toHaveLength(6);
    });

    it('pushes nothing to a recipient with no matching token (skipped, not failed)', async () => {
      const { pg } = fakePg({
        claim: [row({ user_id: USER_2 })],
        lookup: [{ user_id: USER_1, tenant_id: TENANT_A, token: 'tok-a' }],
      });
      const sender = new ScriptedSender();
      await tick(new PushSweepService(pg, sender, config()));

      expect(sender.sendEach).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipped 1'),
      );
    });

    it('never pushes a row to another tenant the same user belongs to', async () => {
      // Same user, two tenants. The tenant guard (SQL) returns the token for
      // (user, TENANT_A) only; a row for TENANT_B must not borrow it.
      const { pg } = fakePg({
        claim: [row({ id: 'n-a', tenant_id: TENANT_A }), row({ id: 'n-b', tenant_id: TENANT_B })],
        lookup: [{ user_id: USER_1, tenant_id: TENANT_A, token: 'tok-a' }],
      });
      const sender = new ScriptedSender();
      await tick(new PushSweepService(pg, sender, config()));

      expect(sender.sendEach.mock.calls[0][0]).toHaveLength(1);
      expect(sender.sendEach.mock.calls[0][0][0].token).toBe('tok-a');
    });

    it('sends nothing and does not throw for an empty claim', async () => {
      const { pg } = fakePg({ claim: [] });
      const sender = new ScriptedSender();
      await expect(tick(new PushSweepService(pg, sender, config()))).resolves.toBeUndefined();
      expect(sender.sendEach).not.toHaveBeenCalled();
    });
  });

  describe('send chunking', () => {
    it('splits 1,100 messages into FCM batches of 500, 500 and 100', async () => {
      const claim = Array.from({ length: 1100 }, (_, i) => row({ id: `n-${i}` }));
      const { pg } = fakePg({
        claim,
        lookup: [{ user_id: USER_1, tenant_id: TENANT_A, token: 'tok-a' }],
      });
      // One row per message: the lookup answers per row, so 1,100 messages.
      const sender = new ScriptedSender();
      await tick(new PushSweepService(pg, sender, config()));

      expect(sender.sendEach.mock.calls.map((c) => c[0].length)).toEqual([
        500, 500, 100,
      ]);
    });
  });

  describe('failure matrix', () => {
    const oneRowOneToken = (): {
      pg: PgPoolFactory;
      calls: { sql: string; params: unknown[] }[];
    } =>
      fakePg({
        claim: [row()],
        lookup: [{ user_id: USER_1, tenant_id: TENANT_A, token: 'tok-a' }],
      });

    const outcome = (
      message: PushMessage,
      kind: 'unregistered' | 'invalid' | 'retryable' | 'permanent',
      code: string,
    ): PushSendOutcome => ({
      message,
      error: { kind, code, detail: 'detail' },
    });

    it('deletes a token on unregistered and invalid, with no retry', async () => {
      const { pg, calls } = oneRowOneToken();
      const sender = new ScriptedSender();
      sender.sendEach.mockImplementationOnce(async (messages) => [
        outcome(messages[0], 'unregistered', 'messaging/registration-token-not-registered'),
      ]);
      const service = new PushSweepService(pg, sender, config());
      (service as unknown as { retryDelayMs: () => number }).retryDelayMs = () => 0;

      await tick(service);

      expect(sender.sendEach).toHaveBeenCalledTimes(1);
      const del = calls.find((c) => c.sql.includes('delete from public.device_tokens'));
      expect(del?.params).toEqual([['tok-a']]);
    });

    it('stamps last_failure on a permanent error and does not retry', async () => {
      const { pg, calls } = oneRowOneToken();
      const sender = new ScriptedSender();
      sender.sendEach.mockImplementationOnce(async (messages) => [
        outcome(messages[0], 'permanent', 'messaging/invalid-argument'),
      ]);
      await tick(new PushSweepService(pg, sender, config()));

      expect(sender.sendEach).toHaveBeenCalledTimes(1);
      const stamp = calls.find((c) => c.sql.includes('set last_failure'));
      expect(stamp?.params).toEqual([['tok-a'], ['messaging/invalid-argument']]);
    });

    it('retries a retryable error and succeeds on the second attempt', async () => {
      const { pg, calls } = oneRowOneToken();
      const sender = new ScriptedSender();
      sender.sendEach
        .mockImplementationOnce(async (messages) => [
          outcome(messages[0], 'retryable', 'messaging/server-unavailable'),
        ])
        .mockImplementationOnce(async (messages) =>
          messages.map((message) => ({ message, error: null })),
        );
      const service = new PushSweepService(pg, sender, config());
      (service as unknown as { retryDelayMs: () => number }).retryDelayMs = () => 0;

      await tick(service);

      expect(sender.sendEach).toHaveBeenCalledTimes(2);
      // The retry carries only the failed message, not the whole batch.
      expect(sender.sendEach.mock.calls[1][0]).toHaveLength(1);
      expect(calls.some((c) => c.sql.includes('set last_failure'))).toBe(false);
    });

    it('gives up after two retries: three attempts total, then stamps last_failure', async () => {
      const { pg, calls } = oneRowOneToken();
      const sender = new ScriptedSender();
      sender.sendEach.mockImplementation(async (messages) => [
        outcome(messages[0], 'retryable', 'messaging/quota-exceeded'),
      ]);
      const service = new PushSweepService(pg, sender, config());
      (service as unknown as { retryDelayMs: () => number }).retryDelayMs = () => 0;

      await tick(service);

      expect(sender.sendEach).toHaveBeenCalledTimes(3);
      const stamp = calls.find((c) => c.sql.includes('set last_failure'));
      expect(stamp?.params).toEqual([['tok-a'], ['messaging/quota-exceeded']]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('retries exhausted'),
      );
    });

    it('a transport failure on the whole chunk is retried, not thrown', async () => {
      const { pg, calls } = oneRowOneToken();
      const sender = new ScriptedSender();
      sender.sendEach.mockRejectedValue(new Error('ECONNRESET'));
      const service = new PushSweepService(pg, sender, config());
      (service as unknown as { retryDelayMs: () => number }).retryDelayMs = () => 0;

      await expect(tick(service)).resolves.toBeUndefined();

      expect(sender.sendEach).toHaveBeenCalledTimes(3);
      const stamp = calls.find((c) => c.sql.includes('set last_failure'));
      expect(stamp?.params).toEqual([['tok-a'], ['messaging/transport-error']]);
    });

  });
});
