import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../../common/factories/supabase-client.factory';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { ReportRegistry } from '../registry/report-registry';
import { ReportRequestStatus } from '../enums/report-status.enum';
import { ReportRequestRow } from '../report-response.model';
import { ReportPipelineService } from './report-pipeline.service';
import { ReportQueueService } from '../report-queue.service';
import { ReportWorker } from './report-worker';
import { getCorrelationContext } from '../../common/correlation/correlation.context';
import type { CorrelationContext } from '../../common/correlation/correlation.context';

/**
 * The guarded-UPDATE chains of the claim/stamp helpers: awaited directly —
 * thenable resolving `result`.
 */
function updateQb(result: { data: unknown; error: unknown }) {
  const qb: Record<string, jest.Mock> & { then: jest.Mock } = {} as never;
  for (const m of ['update', 'eq', 'lt', 'select']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.then = jest.fn((resolve: (v: unknown) => unknown) => resolve(result));
  return qb;
}

/** The candidate select chain: select('id, tenant_id, attempt_count')
 *  .eq[.lt][.not].order.limit — `.not` is the 23-8 paused-tenant filter,
 *  applied only when the paused set is non-empty. */
function candidateQb(result: { data: unknown; error: unknown }) {
  const qb: Record<string, jest.Mock> & { then: jest.Mock } = {} as never;
  for (const m of ['eq', 'lt', 'not', 'order', 'limit']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.select = jest.fn().mockReturnValue(qb);
  qb.then = jest.fn((resolve: (v: unknown) => unknown) => resolve(result));
  return qb;
}

/** The readRow chain: select('*').eq('id', ...).maybeSingle(). */
function readRowQb(result: { data: ReportRequestRow | null; error: unknown }) {
  const maybeSingle = jest.fn().mockResolvedValue(result);
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  return { select, eq, maybeSingle };
}

const TENANT_ID = 'tenant-uuid';

function reportRow(
  overrides: Partial<ReportRequestRow> = {},
): ReportRequestRow {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    tenant_id: TENANT_ID,
    requested_by: 'owner-uuid',
    report_type: 'technician_job_activity',
    params: {
      start_date: '2026-09-01',
      end_date: '2026-09-07',
      technician_ids: [],
      office_ids: [],
    },
    status: ReportRequestStatus.READY,
    attempt_count: 1,
    locked_until: null,
    r2_key: `${TENANT_ID}/reports/req.pdf`,
    file_size_bytes: 2048,
    error_code: null,
    created_at: '2026-09-20T10:00:00.000Z',
    completed_at: '2026-09-20T10:05:00.000Z',
    ...overrides,
  };
}

describe('ReportWorker (story 12-3)', () => {
  let worker: ReportWorker;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let pipeline: { run: jest.Mock };
  let registry: { get: jest.Mock };
  let queue: { pausedTenantIds: jest.Mock };

  const CONFIG: Record<string, number> = {
    REPORT_POLL_INTERVAL_SECONDS: 5,
    REPORT_LEASE_SECONDS: 300,
    REPORT_WORKER_CONCURRENCY: 1,
    REPORT_MAX_ATTEMPTS: 3,
  };

  type CandidateResult = { data: unknown; error: unknown };

  /**
   * `from` dispatches on the first chained method / its arguments (see
   * reports.service.spec.ts's mockAdmin doc comment): candidate reads start
   * with select('id, attempt_count') — odd candidate-read calls are the
   * queued poll, even ones the stranded poll; readRow starts with
   * select('*'); claims/stamps start with update(...). Within one tick the
   * worker does: queued read → stranded read → per candidate: claim update
   * (maybe recovery update, maybe stamp update) → readRow select('*').
   */
  function mockAdmin(opts: {
    queued?: CandidateResult;
    stranded?: CandidateResult;
    row?: { data: ReportRequestRow | null; error: unknown };
    updateResults?: { data: unknown; error: unknown }[];
    notifError?: unknown;
  }) {
    let candidateRead = 0;
    const updatePayloads: Record<string, unknown>[] = [];
    const candidateQbs: ReturnType<typeof candidateQb>[] = [];
    const insert = jest
      .fn()
      .mockResolvedValue({ error: opts.notifError ?? null });

    const from = jest.fn((table: string) => {
      if (table === 'notifications') {
        return { insert };
      }
      if (table !== 'report_requests') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select: jest.fn((cols: string) => {
          if (cols === '*') {
            return readRowQb(opts.row ?? { data: null, error: null });
          }
          if (cols.includes('attempt_count')) {
            candidateRead += 1;
            const result =
              candidateRead % 2 === 1
                ? (opts.queued ?? { data: [], error: null })
                : (opts.stranded ?? { data: [], error: null });
            const qb = candidateQb(result);
            candidateQbs.push(qb);
            return qb;
          }
          throw new Error(`unexpected select ${cols}`);
        }),
        update: jest.fn((payload: Record<string, unknown>) => {
          updatePayloads.push(payload);
          const result = opts.updateResults?.length
            ? opts.updateResults.shift()!
            : { data: null, error: null };
          return updateQb(result);
        }),
      };
    });
    supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);

    return { from, insert, updatePayloads, candidateQbs };
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));

    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportWorker,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: ReportPipelineService, useValue: { run: jest.fn() } },
        {
          provide: ReportRegistry,
          useValue: {
            get: jest.fn(() => ({
              type: 'technician_job_activity',
              label: 'Technician Job Activity',
            })),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => CONFIG[key]) },
        },
        {
          provide: ReportQueueService,
          useValue: { pausedTenantIds: jest.fn().mockResolvedValue(new Set()) },
        },
      ],
    }).compile();

    worker = module.get<ReportWorker>(ReportWorker);
    supabaseClientFactory = module.get(SupabaseClientFactory);
    pipeline = module.get(ReportPipelineService);
    registry = module.get(ReportRegistry);
    queue = module.get(ReportQueueService) as {
      pausedTenantIds: jest.Mock;
    };
  });

  afterEach(() => {
    worker.onModuleDestroy();
    jest.useRealTimers();
  });

  /** Advance exactly one poll interval and let the tick's promises settle. */
  async function tickOnce() {
    await jest.advanceTimersByTimeAsync(
      CONFIG.REPORT_POLL_INTERVAL_SECONDS * 1000,
    );
  }

  describe('interval lifecycle', () => {
    it('polls on the configured interval and stops after onModuleDestroy', async () => {
      const { from } = mockAdmin({});

      worker.onApplicationBootstrap();
      await tickOnce();

      // The tick read candidates through the admin client.
      expect(from).toHaveBeenCalledWith('report_requests');
      expect(supabaseClientFactory.createAdmin).toHaveBeenCalled();

      worker.onModuleDestroy();
      await tickOnce();
      const callsAfterDestroy = (from as jest.Mock).mock.calls.length;

      await tickOnce();
      expect((from as jest.Mock).mock.calls.length).toBe(callsAfterDestroy);
    });
  });

  describe('claiming', () => {
    it('runs each job inside a per-job correlation scope seeded from the claimed row', async () => {
      const row = reportRow({
        status: ReportRequestStatus.GENERATING,
        attempt_count: 1,
      });
      mockAdmin({
        queued: { data: [{ id: row.id, attempt_count: 0 }], error: null },
        updateResults: [{ data: [row], error: null }],
        row: { data: row, error: null },
      });
      let seen!: CorrelationContext | null;
      pipeline.run.mockImplementation(async () => {
        seen = getCorrelationContext();
      });

      worker.onApplicationBootstrap();
      await tickOnce();

      expect(seen).not.toBeNull();
      expect(seen?.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // Seeded from the claimed row, not left null for the whole job.
      expect(seen?.tenantId).toBe(row.tenant_id);
      expect(seen?.userId).toBe(row.requested_by);
      expect(seen?.sessionId).toBeNull();
    });

    it('keeps the correlation scope active when a job fails (failure line stays attributed)', async () => {
      const row = reportRow({
        status: ReportRequestStatus.GENERATING,
        attempt_count: 1,
      });
      mockAdmin({
        queued: { data: [{ id: row.id, attempt_count: 0 }], error: null },
        updateResults: [{ data: [row], error: null }],
        row: { data: row, error: null },
      });
      let seen!: CorrelationContext | null;
      pipeline.run.mockImplementation(async () => {
        seen = getCorrelationContext();
        throw new Error('pipeline exploded');
      });
      const errorSpy = jest
        .spyOn(worker['logger'], 'error')
        .mockImplementation();

      worker.onApplicationBootstrap();
      await tickOnce();

      expect(seen).not.toBeNull();
      // The catch logging the failure ran inside the scope; the next tick
      // still proceeds (the failure is contained per job).
      expect(errorSpy).toHaveBeenCalledTimes(1);
      await tickOnce();
      expect(pipeline.run).toHaveBeenCalledTimes(1);
    });

    it('claims each queued candidate through the guarded UPDATE and runs the pipeline', async () => {
      const row = reportRow({
        status: ReportRequestStatus.GENERATING,
        attempt_count: 1,
      });
      const { updatePayloads } = mockAdmin({
        queued: { data: [{ id: row.id, attempt_count: 0 }], error: null },
        updateResults: [{ data: [row], error: null }],
        row: { data: row, error: null },
      });

      worker.onApplicationBootstrap();
      await tickOnce();

      // Fresh claim: generating + lease + attempt bump, guarded on queued.
      expect(updatePayloads[0]).toEqual({
        status: ReportRequestStatus.GENERATING,
        locked_until: '2026-09-20T10:05:05.000Z', // tick time (10:00:05) + 300s lease
        attempt_count: 1,
      });
      expect(pipeline.run).toHaveBeenCalledTimes(1);
      expect(pipeline.run).toHaveBeenCalledWith(row);
    });

    it('processes at most REPORT_WORKER_CONCURRENCY candidates per tick', async () => {
      const row = reportRow({
        status: ReportRequestStatus.GENERATING,
        attempt_count: 1,
      });
      const candidates = [
        { id: 'req-1', attempt_count: 0 },
        { id: 'req-2', attempt_count: 0 },
        { id: 'req-3', attempt_count: 0 },
      ];
      mockAdmin({
        queued: { data: candidates, error: null },
        updateResults: [
          { data: [row], error: null },
          { data: [row], error: null },
        ],
        row: { data: row, error: null },
      });

      worker.onApplicationBootstrap();
      await tickOnce();

      expect(pipeline.run).toHaveBeenCalledTimes(1); // concurrency 1
    });

    it('skips a tick while the previous one is still running (no stacking)', async () => {
      const row = reportRow({
        status: ReportRequestStatus.GENERATING,
        attempt_count: 1,
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      pipeline.run.mockReturnValueOnce(gate);
      mockAdmin({
        queued: { data: [{ id: row.id, attempt_count: 0 }], error: null },
        // One claim result per tick that reaches the claim (ticks 1 and 3).
        updateResults: [
          { data: [row], error: null },
          { data: [row], error: null },
        ],
        row: { data: row, error: null },
      });

      worker.onApplicationBootstrap();
      await tickOnce(); // tick 1 — parked inside pipeline.run
      await tickOnce(); // tick 2 — must be skipped by the isRunning guard

      expect(pipeline.run).toHaveBeenCalledTimes(1);

      release();
      await tickOnce(); // tick 3 — runs again

      expect(pipeline.run).toHaveBeenCalledTimes(2);
    });

    it('a pipeline failure does not wedge the worker — the next tick still runs', async () => {
      const row = reportRow({
        status: ReportRequestStatus.GENERATING,
        attempt_count: 1,
      });
      pipeline.run.mockRejectedValueOnce(new Error('boom'));
      const { from } = mockAdmin({
        queued: { data: [{ id: row.id, attempt_count: 0 }], error: null },
        // One claim result per tick (ticks 1 and 2).
        updateResults: [
          { data: [row], error: null },
          { data: [row], error: null },
        ],
        row: { data: row, error: null },
      });

      worker.onApplicationBootstrap();
      await tickOnce(); // tick 1 — pipeline.run rejects
      expect(pipeline.run).toHaveBeenCalledTimes(1);

      await tickOnce(); // tick 2 — the worker must still poll

      expect(pipeline.run).toHaveBeenCalledTimes(2);
      expect(from).toHaveBeenCalled();
    });
  });

  describe('lease recovery + attempt budget', () => {
    it('a recovered stranded row past max attempts is failed, not re-run', async () => {
      const stranded = reportRow({
        status: ReportRequestStatus.GENERATING,
        attempt_count: 4, // recovery bump puts it past REPORT_MAX_ATTEMPTS (3)
      });
      const { updatePayloads, insert } = mockAdmin({
        queued: { data: [], error: null },
        stranded: {
          data: [{ id: stranded.id, attempt_count: 3 }],
          error: null,
        },
        // claim misses, recovery wins, then the permanent-failure stamp
        updateResults: [
          { data: [], error: null },
          { data: [stranded], error: null },
          { data: null, error: null },
        ],
        row: {
          data: {
            ...stranded,
            status: ReportRequestStatus.FAILED,
            error_code: ErrorCode.REPORT_GENERATION_FAILED,
          },
          error: null,
        },
      });

      worker.onApplicationBootstrap();
      await tickOnce();

      expect(pipeline.run).not.toHaveBeenCalled();
      // Update order: fresh claim (miss) → recovery claim → failure stamp.
      expect(updatePayloads[2]).toEqual({
        status: ReportRequestStatus.FAILED,
        error_code: ErrorCode.REPORT_GENERATION_FAILED,
        completed_at: expect.any(String),
      });
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'report_failed' }),
      );
    });

    it('a recovered row within the attempt budget is re-run through the pipeline', async () => {
      const row = reportRow({
        status: ReportRequestStatus.GENERATING,
        attempt_count: 2,
      });
      mockAdmin({
        queued: { data: [], error: null },
        stranded: { data: [{ id: row.id, attempt_count: 1 }], error: null },
        updateResults: [
          { data: [], error: null },
          { data: [row], error: null },
        ],
        row: { data: row, error: null },
      });

      worker.onApplicationBootstrap();
      await tickOnce();

      expect(pipeline.run).toHaveBeenCalledWith(row);
    });

    it('a claim race lost on both paths is a silent no-op', async () => {
      mockAdmin({
        queued: { data: [{ id: 'req-x', attempt_count: 0 }], error: null },
        updateResults: [
          { data: [], error: null },
          { data: [], error: null },
        ],
        row: { data: null, error: null },
      });

      worker.onApplicationBootstrap();
      await tickOnce();

      expect(pipeline.run).not.toHaveBeenCalled();
    });
  });

  describe('terminal notifications', () => {
    it('notifies requested_by after the terminal stamp (report_ready, label from registry)', async () => {
      const row = reportRow({ status: ReportRequestStatus.READY });
      const { insert } = mockAdmin({
        queued: { data: [{ id: row.id, attempt_count: 0 }], error: null },
        updateResults: [
          {
            data: [reportRow({ status: ReportRequestStatus.GENERATING })],
            error: null,
          },
        ],
        row: { data: row, error: null },
      });

      worker.onApplicationBootstrap();
      await tickOnce();

      expect(insert).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledWith({
        tenant_id: row.tenant_id,
        user_id: row.requested_by,
        job_id: null,
        event_type: 'report_ready',
        payload: {
          reportId: row.id,
          reportType: row.report_type,
          reportLabel: 'Technician Job Activity',
          status: ReportRequestStatus.READY,
          errorCode: null,
        },
      });
    });

    it('falls back to the raw report_type as label when the registry lost the type', async () => {
      const row = reportRow({ status: ReportRequestStatus.READY });
      registry.get.mockReturnValue(undefined);
      const { insert } = mockAdmin({
        queued: { data: [{ id: row.id, attempt_count: 0 }], error: null },
        updateResults: [
          {
            data: [reportRow({ status: ReportRequestStatus.GENERATING })],
            error: null,
          },
        ],
        row: { data: row, error: null },
      });

      worker.onApplicationBootstrap();
      await tickOnce();

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ reportLabel: row.report_type }),
        }),
      );
    });

    it('a non-terminal row (still generating) gets no notification', async () => {
      const row = reportRow({ status: ReportRequestStatus.GENERATING });
      const { insert } = mockAdmin({
        queued: { data: [{ id: row.id, attempt_count: 0 }], error: null },
        updateResults: [
          {
            data: [reportRow({ status: ReportRequestStatus.GENERATING })],
            error: null,
          },
        ],
        row: { data: row, error: null },
      });

      worker.onApplicationBootstrap();
      await tickOnce();

      expect(insert).not.toHaveBeenCalled();
    });
  });

  describe('the per-tenant report-queue pause (23-8)', () => {
    it('attaches the not.in paused-tenant filter to BOTH candidate queries — the SQL exclusion the fence runs on', async () => {
      const { candidateQbs } = mockAdmin({});
      queue.pausedTenantIds.mockResolvedValue(new Set(['tenant-uuid']));

      worker.onApplicationBootstrap();
      await tickOnce();

      // The pinned contract is the filter ARGUMENTS (what the worker
      // executes against Postgres); the row-level exclusion itself happens
      // in the database, where the PostgREST `not.in` CSV idiom is the
      // same one sync.service runs in production.
      expect(candidateQbs).toHaveLength(2); // queued + stranded
      for (const qb of candidateQbs) {
        expect(qb.not).toHaveBeenCalledWith('tenant_id', 'in', '(tenant-uuid)');
      }
      expect(pipeline.run).not.toHaveBeenCalled(); // no candidates came back
    });

    it('an empty pause set (no pause, or an expired one) skips the filter and claims again', async () => {
      // The expired pause is filtered OUT by the queue service (its own
      // spec pins that), so the worker sees an empty set — the filter is
      // skipped entirely, never a meaningless `not.in.()`.
      const { candidateQbs } = mockAdmin({
        queued: {
          data: [{ id: 'req-1', tenant_id: TENANT_ID, attempt_count: 0 }],
          error: null,
        },
        updateResults: [
          {
            data: [reportRow({ status: ReportRequestStatus.GENERATING })],
            error: null,
          },
        ],
        row: {
          data: reportRow({ status: ReportRequestStatus.GENERATING }),
          error: null,
        },
      });

      worker.onApplicationBootstrap();
      await tickOnce();

      for (const qb of candidateQbs) {
        expect(qb.not).not.toHaveBeenCalled();
      }
      expect(pipeline.run).toHaveBeenCalledTimes(1);
    });

    it('other tenants keep flowing while one tenant is paused', async () => {
      const { candidateQbs } = mockAdmin({
        queued: {
          data: [{ id: 'req-1', tenant_id: TENANT_ID, attempt_count: 0 }],
          error: null,
        },
        updateResults: [
          {
            data: [reportRow({ status: ReportRequestStatus.GENERATING })],
            error: null,
          },
        ],
        row: {
          data: reportRow({ status: ReportRequestStatus.GENERATING }),
          error: null,
        },
      });
      queue.pausedTenantIds.mockResolvedValue(new Set(['paused-tenant']));

      worker.onApplicationBootstrap();
      await tickOnce();

      // Only the PAUSED tenant's ids are excluded, both queries.
      for (const qb of candidateQbs) {
        expect(qb.not).toHaveBeenCalledWith(
          'tenant_id',
          'in',
          '(paused-tenant)',
        );
      }
      expect(pipeline.run).toHaveBeenCalledTimes(1);
    });

    it('the exclusive worker (test env) never consults the pause', async () => {
      // Built fresh: REPORT_WORKER_EXCLUSIVE='true' — the pause's intended
      // exemption (the fence protects against OTHER workers, and a test
      // must not stall on its own pause).
      const module2: TestingModule = await Test.createTestingModule({
        providers: [
          ReportWorker,
          {
            provide: SupabaseClientFactory,
            useValue: { createAdmin: jest.fn() },
          },
          { provide: ReportPipelineService, useValue: { run: jest.fn() } },
          { provide: ReportRegistry, useValue: { get: jest.fn() } },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(
                (key: string) =>
                  (
                    ({
                      REPORT_WORKER_EXCLUSIVE: 'true',
                      REPORT_WORKER_CONCURRENCY: 1,
                    }) as Record<string, unknown>
                  )[key],
              ),
            },
          },
          {
            provide: ReportQueueService,
            useValue: { pausedTenantIds: jest.fn() },
          },
        ],
      }).compile();
      const worker2 = module2.get<ReportWorker>(ReportWorker);
      const factory2 = module2.get(SupabaseClientFactory);
      const queue2 = module2.get(ReportQueueService) as {
        pausedTenantIds: jest.Mock;
      };
      const pipeline2 = module2.get(ReportPipelineService);

      let candidateRead = 0;
      const from = jest.fn((table: string) => {
        if (table !== 'report_requests') {
          throw new Error(`unexpected table ${table}`);
        }
        return {
          select: jest.fn((cols: string) => {
            if (cols === '*') {
              return readRowQb({
                data: reportRow({ status: ReportRequestStatus.GENERATING }),
                error: null,
              });
            }
            candidateRead += 1;
            return candidateQb(
              candidateRead % 2 === 1
                ? {
                    data: [
                      { id: 'req-1', tenant_id: TENANT_ID, attempt_count: 0 },
                    ],
                    error: null,
                  }
                : { data: [], error: null },
            );
          }),
          update: jest.fn().mockReturnValue(
            updateQb({
              data: [reportRow({ status: ReportRequestStatus.GENERATING })],
              error: null,
            }),
          ),
        };
      });
      factory2.createAdmin.mockReturnValue({ from });
      queue2.pausedTenantIds.mockResolvedValue(new Set(['tenant-uuid']));

      worker2.onApplicationBootstrap();
      await tickOnce();
      worker2.onModuleDestroy();

      // The pause check never ran, and the claim went through anyway.
      expect(queue2.pausedTenantIds).not.toHaveBeenCalled();
      expect(pipeline2.run).toHaveBeenCalledTimes(1);
    });

    it('refuses to boot an exclusive worker in production (the pause voids there)', async () => {
      const prevEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        await expect(
          Test.createTestingModule({
            providers: [
              ReportWorker,
              {
                provide: SupabaseClientFactory,
                useValue: { createAdmin: jest.fn() },
              },
              { provide: ReportPipelineService, useValue: { run: jest.fn() } },
              { provide: ReportRegistry, useValue: { get: jest.fn() } },
              {
                provide: ConfigService,
                useValue: {
                  get: jest.fn(
                    (key: string) =>
                      (
                        ({ REPORT_WORKER_EXCLUSIVE: 'true' }) as Record<
                          string,
                          unknown
                        >
                      )[key],
                  ),
                },
              },
              {
                provide: ReportQueueService,
                useValue: { pausedTenantIds: jest.fn() },
              },
            ],
          }).compile(),
        ).rejects.toThrow(
          'REPORT_WORKER_EXCLUSIVE is test-only — a deployed worker must respect the report-queue pause',
        );
      } finally {
        process.env['NODE_ENV'] = prevEnv;
      }
    });
  });
});
