import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  fetchTechnicianJobActivityData,
  FetchedJob,
} from './technician-job-activity.data';
import { ReportFetchContext } from './report-definition';

/**
 * Unit tests for the Technician Job Activity fetcher (story 12-5).
 *
 * The Supabase client is a hand-rolled mock: every `from(table)` call pops the
 * next planned result for that table (FIFO) and returns a fully chained,
 * thenable query builder that records every chained call. This mirrors the
 * first-chained-method dispatch of reports.service.spec.ts, but the fetcher
 * awaits chains directly (no `.single()`-terminated tenant chain — the
 * tenants chain IS single-terminated, which the thenable chain covers), so
 * one thenable builder shape fits every query here.
 */

interface ChainResult {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

type ChainCalls = Map<string, unknown[][]>;

interface MockChain {
  chain: Record<string, unknown>;
  calls: ChainCalls;
}

const CHAIN_METHODS = [
  'select',
  'eq',
  'gte',
  'lt',
  'order',
  'in',
  'range',
  'single',
] as const;

/**
 * A query builder mock whose every method records its args and returns the
 * chain itself, and which resolves `result` when awaited (the fetcher awaits
 * builder chains directly; `.single()` just returns the same thenable).
 */
function makeChain(result: ChainResult): MockChain {
  const calls: ChainCalls = new Map();
  const chain: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    chain[method] = jest.fn((...args: unknown[]) => {
      if (!calls.has(method)) calls.set(method, []);
      calls.get(method)!.push(args);
      return chain;
    });
  }
  chain.then = jest.fn((resolve: (v: ChainResult) => unknown) =>
    resolve(result),
  );
  return { chain, calls };
}

/** Per-table FIFO queues of results — one entry per query issued. */
type ClientPlan = Record<string, ChainResult[]>;

interface MockSupabase {
  supabase: unknown;
  from: jest.Mock;
  /** All chains built, keyed by table in call order. */
  chains: Map<string, MockChain[]>;
}

function makeSupabase(plan: ClientPlan): MockSupabase {
  const chains = new Map<string, MockChain[]>();
  const from = jest.fn((table: string) => {
    const queue = plan[table];
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected query to table '${table}'`);
    }
    const mock = makeChain(queue.shift()!);
    if (!chains.has(table)) chains.set(table, []);
    chains.get(table)!.push(mock);
    return mock.chain;
  });
  return { supabase: { from } as unknown, from, chains };
}

interface CtxOpts {
  params?: Partial<ReportFetchContext['params']>;
  maxJobs?: number;
}

function makeCtx(supabase: unknown, opts: CtxOpts = {}): ReportFetchContext {
  return {
    supabase: supabase as ReportFetchContext['supabase'],
    tenantId: 'tenant-uuid',
    requestId: 'req-uuid',
    maxJobs: opts.maxJobs ?? 5000,
    params: {
      start_date: '2026-09-01',
      end_date: '2026-09-07',
      technician_ids: [],
      ...opts.params,
    },
  };
}

/** A raw jobs row as Supabase returns it (join tables nullable). */
function rawJob(overrides: {
  id: string;
  technician_id: string;
  status?: string;
  scheduled_start?: string;
  customers?: { name: string } | null;
  skills?: { name: string } | null;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    job_number: `J-${overrides.id}`,
    technician_id: overrides.technician_id,
    customer_id: `cust-${overrides.id}`,
    status: overrides.status ?? 'completed',
    priority: 'normal',
    scheduled_start: overrides.scheduled_start ?? '2026-09-02T04:00:00Z',
    scheduled_end: null,
    completed_at: null,
    customers:
      overrides.customers === undefined
        ? { name: `Customer ${overrides.id}` }
        : overrides.customers,
    skills:
      overrides.skills === undefined
        ? { name: 'Plumbing' }
        : overrides.skills,
  };
}

const TENANT_OK: ChainResult = {
  data: { company_name: 'Acme Services', address: '12 MG Road' },
  error: null,
};

describe('TechnicianJobActivityData — fetchTechnicianJobActivityData (story 12-5)', () => {
  describe('IST day bounds (UTC+5:30)', () => {
    it('derives the UTC window edges for a single IST day', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [{ data: [], error: null, count: 0 }],
      });

      await fetchTechnicianJobActivityData(
        makeCtx(client.supabase, {
          params: {
            start_date: '2026-09-01',
            end_date: '2026-09-01',
            technician_ids: [],
          },
        }),
      );

      const jobs = client.chains.get('jobs')![0];
      // IST midnight 2026-09-01 = 2026-08-31T18:30:00Z; the exclusive end is
      // IST midnight of 2026-09-02.
      expect(jobs.calls.get('gte')).toEqual([
        ['scheduled_start', '2026-08-31T18:30:00.000Z'],
      ]);
      expect(jobs.calls.get('lt')).toEqual([
        ['scheduled_start', '2026-09-01T18:30:00.000Z'],
      ]);
    });

    it('makes a multi-day range inclusive of the whole end day', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [{ data: [], error: null, count: 0 }],
      });

      await fetchTechnicianJobActivityData(
        makeCtx(client.supabase, {
          params: {
            start_date: '2026-09-01',
            end_date: '2026-09-07',
            technician_ids: [],
          },
        }),
      );

      const jobs = client.chains.get('jobs')![0];
      expect(jobs.calls.get('lt')).toEqual([
        ['scheduled_start', '2026-09-07T18:30:00.000Z'],
      ]);
    });

    it('scopes the jobs query to the tenant and orders by scheduled_start', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [{ data: [], error: null, count: 0 }],
      });

      await fetchTechnicianJobActivityData(makeCtx(client.supabase));

      const jobs = client.chains.get('jobs')![0];
      expect(jobs.calls.get('eq')).toEqual([['tenant_id', 'tenant-uuid']]);
      expect(jobs.calls.get('order')).toEqual([
        ['scheduled_start', { ascending: true }],
      ]);
      expect(jobs.calls.get('range')).toEqual([[0, 999]]);
    });
  });

  describe('paged fetching', () => {
    it('pages beyond the first 1000 rows until fewer than a page comes back', async () => {
      const page1 = Array.from({ length: 1000 }, (_, i) =>
        rawJob({ id: `j${i}`, technician_id: 't1' }),
      );
      const page2 = Array.from({ length: 1000 }, (_, i) =>
        rawJob({ id: `k${i}`, technician_id: 't1' }),
      );
      const page3 = [rawJob({ id: 'last', technician_id: 't1' })];
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          { data: page1, error: null, count: 2001 },
          { data: page2, error: null, count: 2001 },
          { data: page3, error: null, count: 2001 },
        ],
        users: [{ data: [{ id: 't1', name: 'Ravi' }], error: null }],
        // 2001 jobs → ceil(2001 / 500) attachment IN-chunks.
        attachments: [
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
        ],
      });

      const result = await fetchTechnicianJobActivityData(
        makeCtx(client.supabase),
      );

      // One jobs query per page — a fresh builder each time (single-use).
      expect(client.from).toHaveBeenCalledWith('jobs');
      const jobChains = client.chains.get('jobs')!;
      expect(jobChains).toHaveLength(3);
      expect(jobChains[0].calls.get('range')).toEqual([[0, 999]]);
      expect(jobChains[1].calls.get('range')).toEqual([[1000, 1999]]);
      expect(jobChains[2].calls.get('range')).toEqual([[2000, 2999]]);
      expect(result.jobs.map((j) => j.id)).toEqual([
        ...page1.map((_, i) => `j${i}`),
        ...page2.map((_, i) => `k${i}`),
        'last',
      ]);
    });

    it('does not page again when the exact count fits one page', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [rawJob({ id: 'j1', technician_id: 't1' })],
            error: null,
            count: 1,
          },
        ],
        users: [{ data: [{ id: 't1', name: 'Ravi' }], error: null }],
        attachments: [{ data: [], error: null }],
      });

      await fetchTechnicianJobActivityData(makeCtx(client.supabase));

      expect(client.chains.get('jobs')).toHaveLength(1);
    });
  });

  describe('technician selection', () => {
    it('empty technician_ids = all: sections come from the jobs seen', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [
              rawJob({ id: 'j1', technician_id: 't1' }),
              rawJob({ id: 'j2', technician_id: 't2' }),
            ],
            error: null,
            count: 2,
          },
        ],
        users: [
          {
            data: [
              { id: 't1', name: 'Ravi' },
              { id: 't2', name: 'Amit' },
            ],
            error: null,
          },
        ],
        attachments: [{ data: [], error: null }],
      });

      const result = await fetchTechnicianJobActivityData(
        makeCtx(client.supabase),
      );

      expect(result.technicians).toEqual([
        { id: 't1', name: 'Ravi' },
        { id: 't2', name: 'Amit' },
      ]);
      // Names come from one tenant-scoped chunked users query.
      const users = client.chains.get('users')![0];
      expect(users.calls.get('eq')).toEqual([['tenant_id', 'tenant-uuid']]);
      expect(users.calls.get('in')).toEqual([['id', ['t1', 't2']]]);
    });

    it('a selected technician with zero jobs keeps their section (FR18)', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [rawJob({ id: 'j1', technician_id: 't2' })],
            error: null,
            count: 1,
          },
        ],
        users: [
          {
            data: [
              { id: 't1', name: 'Ravi' },
              { id: 't2', name: 'Amit' },
            ],
            error: null,
          },
        ],
        attachments: [{ data: [], error: null }],
      });

      const result = await fetchTechnicianJobActivityData(
        makeCtx(client.supabase, {
          params: {
            start_date: '2026-09-01',
            end_date: '2026-09-07',
            technician_ids: ['t1'],
          },
        }),
      );

      // Selection first (Set insertion order), then the jobs' technicians.
      expect(result.technicians.map((t) => t.id)).toEqual(['t1', 't2']);
      expect(result.technicians.map((t) => t.name)).toEqual(['Ravi', 'Amit']);
    });

    it("a missing users row degrades to 'Unknown technician', not a failure", async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [rawJob({ id: 'j1', technician_id: 't1' })],
            error: null,
            count: 1,
          },
        ],
        users: [{ data: [], error: null }],
        attachments: [{ data: [], error: null }],
      });

      const result = await fetchTechnicianJobActivityData(
        makeCtx(client.supabase),
      );

      expect(result.technicians).toEqual([
        { id: 't1', name: 'Unknown technician' },
      ]);
      expect(result.jobs[0].customerName).toBe('Customer j1');
    });
  });

  describe('attachment counts (photos + signatures, FR17)', () => {
    it('counts photos and signatures per job and skips other types', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [
              rawJob({ id: 'j1', technician_id: 't1' }),
              rawJob({ id: 'j2', technician_id: 't1' }),
            ],
            error: null,
            count: 2,
          },
        ],
        users: [{ data: [{ id: 't1', name: 'Ravi' }], error: null }],
        attachments: [
          {
            data: [
              { job_id: 'j1', attachment_type: 'photo' },
              { job_id: 'j1', attachment_type: 'photo' },
              { job_id: 'j1', attachment_type: 'signature' },
              { job_id: 'j1', attachment_type: 'other' },
              { job_id: 'j2', attachment_type: 'signature' },
            ],
            error: null,
          },
        ],
      });

      const result = await fetchTechnicianJobActivityData(
        makeCtx(client.supabase),
      );

      const byId = new Map(result.jobs.map((j) => [j.id, j]));
      expect(byId.get('j1')!.photoCount).toBe(2);
      expect(byId.get('j1')!.signatureCount).toBe(1);
      expect(byId.get('j2')!.photoCount).toBe(0);
      expect(byId.get('j2')!.signatureCount).toBe(1);
    });

    it('a job with no attachment rows defaults to 0/0', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [rawJob({ id: 'j1', technician_id: 't1' })],
            error: null,
            count: 1,
          },
        ],
        users: [{ data: [{ id: 't1', name: 'Ravi' }], error: null }],
        attachments: [{ data: [], error: null }],
      });

      const result = await fetchTechnicianJobActivityData(
        makeCtx(client.supabase),
      );

      expect(result.jobs[0].photoCount).toBe(0);
      expect(result.jobs[0].signatureCount).toBe(0);
    });

    it('pages attachments past the 1000-row cap per IN chunk', async () => {
      const fullPage = Array.from({ length: 1000 }, () => ({
        job_id: 'j1',
        attachment_type: 'photo',
      }));
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [rawJob({ id: 'j1', technician_id: 't1' })],
            error: null,
            count: 1,
          },
        ],
        users: [{ data: [{ id: 't1', name: 'Ravi' }], error: null }],
        attachments: [
          { data: fullPage, error: null },
          {
            data: Array.from({ length: 500 }, () => ({
              job_id: 'j1',
              attachment_type: 'signature',
            })),
            error: null,
          },
        ],
      });

      const result = await fetchTechnicianJobActivityData(
        makeCtx(client.supabase),
      );

      const attachChains = client.chains.get('attachments')!;
      expect(attachChains).toHaveLength(2);
      expect(attachChains[0].calls.get('range')).toEqual([[0, 999]]);
      expect(attachChains[1].calls.get('range')).toEqual([[1000, 1999]]);
      expect(result.jobs[0].photoCount).toBe(1000);
      expect(result.jobs[0].signatureCount).toBe(500);
    });

    it('issues no attachments query when there are no jobs', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [{ data: [], error: null, count: 0 }],
      });

      const result = await fetchTechnicianJobActivityData(
        makeCtx(client.supabase),
      );

      expect(result.jobs).toEqual([]);
      expect(client.from).not.toHaveBeenCalledWith('attachments');
      expect(client.from).not.toHaveBeenCalledWith('users');
    });
  });

  describe('REPORT_MAX_JOBS oversize guard (FR2)', () => {
    it('fails with 400 REPORT_TOO_LARGE when the exact count exceeds maxJobs', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [rawJob({ id: 'j1', technician_id: 't1' })],
            error: null,
            count: 5001,
          },
        ],
      });

      const promise = fetchTechnicianJobActivityData(
        makeCtx(client.supabase, { maxJobs: 5000 }),
      );

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await promise.catch((e: BadRequestException) => {
        expect((e.getResponse() as Record<string, unknown>).error_code).toBe(
          ErrorCode.REPORT_TOO_LARGE,
        );
        expect((e.getResponse() as Record<string, unknown>).message).toBe(
          'Report range contains too many jobs',
        );
      });
      // The guard fires on the first page — nothing else is ever queried.
      expect(client.from).not.toHaveBeenCalledWith('attachments');
      expect(client.from).not.toHaveBeenCalledWith('users');
    });

    it('a count exactly at maxJobs is allowed', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [rawJob({ id: 'j1', technician_id: 't1' })],
            error: null,
            count: 1,
          },
        ],
        users: [{ data: [{ id: 't1', name: 'Ravi' }], error: null }],
        attachments: [{ data: [], error: null }],
      });

      const result = await fetchTechnicianJobActivityData(
        makeCtx(client.supabase, { maxJobs: 1 }),
      );

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('query errors map to generation failures', () => {
    it('a tenants read error surfaces as a fetch failure', async () => {
      const client = makeSupabase({
        tenants: [{ data: null, error: { message: 'boom' } }],
        // The jobs fetch runs concurrently — it must not shadow the error.
        jobs: [{ data: [], error: null, count: 0 }],
      });

      await expect(
        fetchTechnicianJobActivityData(makeCtx(client.supabase)),
      ).rejects.toThrow('Failed to fetch tenant for report: boom');
    });

    it('a jobs read error surfaces as a fetch failure', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [{ data: null, error: { message: 'boom' } }],
      });

      await expect(
        fetchTechnicianJobActivityData(makeCtx(client.supabase)),
      ).rejects.toThrow('Failed to fetch jobs for report: boom');
    });

    it('a jobs page-2 read error surfaces as a page fetch failure', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: Array.from({ length: 1000 }, (_, i) =>
              rawJob({ id: `j${i}`, technician_id: 't1' }),
            ),
            error: null,
            count: 1500,
          },
          { data: null, error: { message: 'boom' } },
        ],
      });

      await expect(
        fetchTechnicianJobActivityData(makeCtx(client.supabase)),
      ).rejects.toThrow('Failed to fetch jobs page for report: boom');
    });

    it('an attachments read error surfaces as a fetch failure', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [rawJob({ id: 'j1', technician_id: 't1' })],
            error: null,
            count: 1,
          },
        ],
        users: [{ data: [{ id: 't1', name: 'Ravi' }], error: null }],
        attachments: [{ data: null, error: { message: 'boom' } }],
      });

      await expect(
        fetchTechnicianJobActivityData(makeCtx(client.supabase)),
      ).rejects.toThrow('Failed to fetch attachments for report: boom');
    });

    it('a users read error surfaces as a fetch failure', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [rawJob({ id: 'j1', technician_id: 't1' })],
            error: null,
            count: 1,
          },
        ],
        users: [{ data: null, error: { message: 'boom' } }],
        // The attachments fetch runs concurrently — must not shadow the error.
        attachments: [{ data: [], error: null }],
      });

      await expect(
        fetchTechnicianJobActivityData(makeCtx(client.supabase)),
      ).rejects.toThrow('Failed to fetch technicians for report: boom');
    });
  });

  describe('mapped output shape', () => {
    it('maps snake_case rows to camelCase FetchedJobs with resolved names', async () => {
      const client = makeSupabase({
        tenants: [TENANT_OK],
        jobs: [
          {
            data: [
              rawJob({
                id: 'j1',
                technician_id: 't1',
                status: 'in_progress',
                scheduled_start: '2026-09-02T04:00:00Z',
                customers: null,
                skills: null,
              }),
            ],
            error: null,
            count: 1,
          },
        ],
        users: [{ data: [{ id: 't1', name: 'Ravi' }], error: null }],
        attachments: [{ data: [], error: null }],
      });

      const result = await fetchTechnicianJobActivityData(
        makeCtx(client.supabase),
      );

      expect(result.tenant).toEqual({
        companyName: 'Acme Services',
        address: '12 MG Road',
      });
      expect(result.range).toEqual({
        startDate: '2026-09-01',
        endDate: '2026-09-07',
      });
      const expected: FetchedJob = {
        id: 'j1',
        jobNumber: 'J-j1',
        technicianId: 't1',
        customerId: 'cust-j1',
        customerName: 'Unknown customer',
        skillName: null,
        status: 'in_progress',
        priority: 'normal',
        scheduledStart: '2026-09-02T04:00:00Z',
        scheduledEnd: null,
        completedAt: null,
        photoCount: 0,
        signatureCount: 0,
      };
      expect(result.jobs).toEqual([expected]);
    });
  });
});