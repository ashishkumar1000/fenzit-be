import { JobReportsService } from './job-reports.service';
import { ApprovalQueueService } from './approval-queue.service';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';

/**
 * Story 6 service behaviour, with a fake database that records each filter. The
 * rules tests cover the arithmetic; these cover which rows each query asks for.
 */

const TENANT = 'tenant-A';
const OWNER = 'owner-1';
const EMP = 'emp-1';

type Call = { table: string; method: string; args: unknown[] };

function fakeFactory(
  tables: Record<string, { rows?: unknown[]; count?: number; error?: unknown }>,
) {
  const calls: Call[] = [];
  const from = jest.fn((table: string) => {
    const res = tables[table] ?? { rows: [] };
    const outcome = () => ({
      data: res.rows ?? [],
      error: res.error ?? null,
      count: res.count ?? null,
    });
    const node: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'gte',
      'lt',
      'or',
      'not',
      'order',
      'limit',
    ]) {
      node[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args });
        return node;
      };
    }
    node['range'] = (...args: unknown[]) => {
      calls.push({ table, method: 'range', args });
      return Promise.resolve(outcome());
    };
    node['then'] = (
      ok: (v: unknown) => unknown,
      fail: (e: unknown) => unknown,
    ) => Promise.resolve(outcome()).then(ok, fail);
    return node;
  });
  const factory = { createAdmin: jest.fn(() => ({ from })) };
  return { factory, calls, from };
}

/** How many times a table was opened — the light report's promise is ONE
 *  jobs read and ONE memberships read (2026-11-28 slimming). */
const tableReads = (from: jest.Mock, table: string) =>
  from.mock.calls.filter((c) => c[0] === table).length;

const user = (userId: string, role: Role): RequestUser => ({
  userId,
  tenantId: TENANT,
  role,
  platformAdmin: false,
  rawJwt: 'jwt',
});

const members = [
  {
    user_id: OWNER,
    role: 'company_admin',
    status: 'active',
    can_create_jobs: false,
    users: { name: 'Owner' },
  },
  {
    user_id: EMP,
    role: 'employee',
    status: 'active',
    can_create_jobs: true,
    users: { name: 'Asha' },
  },
];

const called = (calls: Call[], table: string, method: string) =>
  calls.filter((c) => c.table === table && c.method === method);

describe('ApprovalQueueService (CAP-10)', () => {
  const NOW = new Date('2026-11-12T12:00:00Z');
  const pendingRow = (
    id: string,
    createdAt: string,
    createdBy: string | null,
  ) => ({
    id,
    job_number: `JB-${id}`,
    created_by: createdBy,
    created_at: createdAt,
    customers: { name: 'Asha Traders' },
    creator: createdBy ? { name: 'Asha' } : null,
  });

  it('the owner queue asks for pending jobs of this company only, oldest first', async () => {
    const { factory, calls } = fakeFactory({ jobs: { rows: [] } });
    await new ApprovalQueueService(factory as never).list(
      user(OWNER, Role.COMPANY_ADMIN),
      {},
      NOW,
    );
    expect(called(calls, 'jobs', 'eq')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ args: ['tenant_id', TENANT] }),
        expect.objectContaining({ args: ['status', 'pending_approval'] }),
      ]),
    );
    expect(called(calls, 'jobs', 'order')).toEqual([
      expect.objectContaining({ args: ['created_at', { ascending: true }] }),
      expect.objectContaining({ args: ['id', { ascending: true }] }),
    ]);
  });

  it('employee and age filters combine: created_by and a created_at cut-off 24 hours back', async () => {
    const { factory, calls } = fakeFactory({ jobs: { rows: [] } });
    await new ApprovalQueueService(factory as never).list(
      user(OWNER, Role.COMPANY_ADMIN),
      { employeeId: EMP, olderThanHours: 24 },
      NOW,
    );
    expect(called(calls, 'jobs', 'eq')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ args: ['created_by', EMP] }),
      ]),
    );
    expect(called(calls, 'jobs', 'lt')).toEqual([
      expect.objectContaining({
        args: ['created_at', '2026-11-11T12:00:00.000Z'],
      }),
    ]);
  });

  it("an employee's own list is forced to the caller, whatever they ask for", async () => {
    const { factory, calls } = fakeFactory({ jobs: { rows: [] } });
    await new ApprovalQueueService(factory as never).listOwn(
      user(EMP, Role.EMPLOYEE),
      {},
      NOW,
    );
    expect(called(calls, 'jobs', 'eq')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ args: ['created_by', EMP] }),
      ]),
    );
  });

  it('a page that is full sets a cursor; the next page asks for rows after it', async () => {
    const rows = [
      pendingRow(
        '11111111-1111-4111-8111-111111111111',
        '2026-11-10T00:00:00Z',
        EMP,
      ),
      pendingRow(
        '22222222-2222-4222-8222-222222222222',
        '2026-11-10T01:00:00Z',
        EMP,
      ),
      pendingRow(
        '33333333-3333-4333-8333-333333333333',
        '2026-11-10T02:00:00Z',
        EMP,
      ),
    ];
    const { factory } = fakeFactory({ jobs: { rows } });
    const page = await new ApprovalQueueService(factory as never).list(
      user(OWNER, Role.COMPANY_ADMIN),
      { limit: 2 },
      NOW,
    );
    expect(page.data).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(page.hasMore).toBe(true);
  });

  it('age in whole hours; a job with no creator shows no employee', async () => {
    const { factory } = fakeFactory({
      jobs: {
        rows: [
          pendingRow(
            '11111111-1111-4111-8111-111111111111',
            '2026-11-11T10:30:00Z',
            null,
          ),
        ],
      },
    });
    const page = await new ApprovalQueueService(factory as never).list(
      user(OWNER, Role.COMPANY_ADMIN),
      {},
      NOW,
    );
    expect(page.data[0]).toMatchObject({
      ageHours: 25,
      employee: null,
      customerName: 'Asha Traders',
    });
  });
});

describe('JobReportsService (CAP-8 data)', () => {
  it('the employee report counts only the caller jobs (no other employee leaks in)', async () => {
    const { factory, calls } = fakeFactory({
      memberships: { rows: members },
      jobs: { rows: [], count: 0 },
    });
    await new JobReportsService(factory as never).employeeReport(
      user(EMP, Role.EMPLOYEE),
      {},
    );
    expect(called(calls, 'jobs', 'eq')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ args: ['created_by', EMP] }),
      ]),
    );
  });

  it('the light owner report splits owner and employee jobs: only employee jobs feed the pending count', async () => {
    const jobs = [
      {
        id: 'j1',
        job_number: 'JB-1',
        created_by: EMP,
        status: 'pending_approval',
        created_at: '2026-11-11T00:00:00Z',
        decided_at: null,
        rejection_reason: null,
      },
      {
        id: 'j2',
        job_number: 'JB-2',
        created_by: OWNER,
        status: 'pending_approval',
        created_at: '2026-11-11T00:00:00Z',
        decided_at: null,
        rejection_reason: null,
      },
      {
        id: 'j3',
        job_number: 'JB-3',
        created_by: EMP,
        status: 'cancelled',
        created_at: '2026-11-11T00:00:00Z',
        decided_at: '2026-11-11T01:00:00Z',
        rejection_reason: null,
      },
    ];
    const { factory, from } = fakeFactory({
      memberships: { rows: members },
      jobs: { rows: jobs },
    });
    const report = await new JobReportsService(factory as never).ownerReport(
      user(OWNER, Role.COMPANY_ADMIN),
      {},
    );
    expect(report.headline).toEqual({
      employeeCreated: 2,
      employeeApproved: 0,
      employeeAutoApproved: 0,
      ownerCreated: 1,
    });
    // The owner's own pending job is not in the count.
    expect(report.pipeline).toEqual({ pending: 1 });
    // The light report carries no chart sections and no per-employee table —
    // the overview page must ask for charts explicitly (2026-11-28 slimming).
    expect('trend' in report).toBe(false);
    expect('workforce' in report).toBe(false);
    expect('perEmployee' in report).toBe(false);
    // The slimming's promise: the light read is one jobs page + one
    // memberships page — the workforce chart's second reads never run.
    expect(tableReads(from, 'jobs')).toBe(1);
    expect(tableReads(from, 'memberships')).toBe(1);
  });

  it('?charts=true adds the exec dashboard\'s trend and workforce sections', async () => {
    const { factory, from } = fakeFactory({
      memberships: {
        rows: [
          // The employee who creates the jobs below — active since before
          // the window.
          {
            ...members[1],
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          },
          // A member removed mid-window: counted while present, gone once
          // its removal (updated_at) is behind the cut.
          {
            user_id: 'u-gone',
            role: 'employee',
            status: 'removed',
            can_create_jobs: false,
            users: { name: 'Gone' },
            created_at: '2026-11-02T00:00:00Z',
            updated_at: '2026-11-07T00:00:00Z',
          },
        ],
      },
      jobs: {
        rows: [
          // Employee-created at the window's start, approval off — auto
          // counts from the first bucket on.
          {
            id: 'j-auto',
            job_number: 'JB-1',
            created_by: EMP,
            status: 'scheduled',
            created_at: '2026-11-01T10:00:00Z',
            decided_at: null,
            rejection_reason: null,
          },
          // Employee-created in bucket 2, approved mid-window (after the
          // second cut, before the third): the approved line must move at
          // the DECISION, not the creation.
          {
            id: 'j-approved',
            job_number: 'JB-2',
            created_by: EMP,
            status: 'scheduled',
            created_at: '2026-11-03T10:00:00Z',
            decided_at: '2026-11-05T10:00:00Z',
            rejection_reason: null,
          },
          // Waiting since bucket 2 — the chart's Needs Approval line.
          {
            id: 'j-pending',
            job_number: 'JB-3',
            created_by: EMP,
            status: 'pending_approval',
            created_at: '2026-11-03T10:00:00Z',
            decided_at: null,
            rejection_reason: null,
          },
          // Owner-created late in the window — never waits for approval.
          {
            id: 'j-owner',
            job_number: 'JB-4',
            created_by: OWNER,
            status: 'scheduled',
            created_at: '2026-11-09T10:00:00Z',
            decided_at: null,
            rejection_reason: null,
          },
        ],
      },
    });
    const report = await new JobReportsService(factory as never).ownerReport(
      user(OWNER, Role.COMPANY_ADMIN),
      // A fixed 10-day window: five two-day slices, cuts at the IST-day
      // ends of 11-02, 11-04, 11-06, 11-08 and 11-10.
      { from: '2026-11-01', to: '2026-11-10', charts: 'true' },
    );
    expect(report.trend).toBeDefined();
    // One approval over one needing-decision job — 100%.
    expect(report.trend.turnaroundEfficiency).toBe(1);
    // Cumulative flow, per bucket: creation counts from the job's bucket;
    // the approved count only from the bucket past its decision instant;
    // the owner job only in the last bucket. The mid-window approval must
    // NOT light up buckets 1-2 (review 2026-11-28: an as-of fact).
    expect(report.trend.buckets).toEqual([
      { from: '2026-11-01', to: '2026-11-02', employeeCreated: 1, employeeApproved: 0, employeeAutoApproved: 1, ownerCreated: 0 },
      { from: '2026-11-03', to: '2026-11-04', employeeCreated: 3, employeeApproved: 0, employeeAutoApproved: 1, ownerCreated: 0 },
      { from: '2026-11-05', to: '2026-11-06', employeeCreated: 3, employeeApproved: 1, employeeAutoApproved: 1, ownerCreated: 0 },
      { from: '2026-11-07', to: '2026-11-08', employeeCreated: 3, employeeApproved: 1, employeeAutoApproved: 1, ownerCreated: 0 },
      { from: '2026-11-09', to: '2026-11-10', employeeCreated: 3, employeeApproved: 1, employeeAutoApproved: 1, ownerCreated: 1 },
    ]);
    // Workforce as-of each cut: the removal takes the second member out of
    // `total` from the fourth bucket on; needsApproval counts ONLY jobs
    // that genuinely waited — the auto-approved and owner-created jobs
    // never did (review 2026-11-28). Two rows wait during bucket 2 (the
    // still-pending job AND the not-yet-decided approved job); from the
    // third bucket the decision stamps settle it to one.
    expect(report.workforce.buckets).toEqual([
      { from: '2026-11-01', to: '2026-11-02', totalEmployees: 2, activeEmployees: 1, pendingInvites: 0, needsApproval: 0 },
      { from: '2026-11-03', to: '2026-11-04', totalEmployees: 2, activeEmployees: 1, pendingInvites: 0, needsApproval: 2 },
      { from: '2026-11-05', to: '2026-11-06', totalEmployees: 2, activeEmployees: 1, pendingInvites: 0, needsApproval: 1 },
      { from: '2026-11-07', to: '2026-11-08', totalEmployees: 1, activeEmployees: 1, pendingInvites: 0, needsApproval: 1 },
      { from: '2026-11-09', to: '2026-11-10', totalEmployees: 1, activeEmployees: 1, pendingInvites: 0, needsApproval: 1 },
    ]);
    // The chart reads cost the second jobs page (the 730-day pending pool)
    // and the second memberships page.
    expect(tableReads(from, 'jobs')).toBe(2);
    expect(tableReads(from, 'memberships')).toBe(2);
  });

  it('an inverted window is refused before any query runs', async () => {
    const { factory } = fakeFactory({});
    await expect(
      new JobReportsService(factory as never).ownerReport(
        user(OWNER, Role.COMPANY_ADMIN),
        {
          from: '2026-11-13',
          to: '2026-11-12',
        },
      ),
    ).rejects.toBeDefined();
    expect(factory.createAdmin).not.toHaveBeenCalled();
  });
});
