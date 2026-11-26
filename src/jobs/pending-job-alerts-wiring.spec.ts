import { InternalServerErrorException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JobsService } from './jobs.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CustomersService } from '../customers/customers.service';
import { StorageService } from '../storage/storage.service';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { memberRow } from '../../test/helpers/member-rows-stub';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import * as alerts from './pending-job-notifications';

/**
 * Story 5 wiring (CAP-4, CAP-6): the service calls each pending-job alert on the
 * right path, after the write, and never on the wrong one. The alert helpers
 * themselves are tested in pending-job-notifications.spec.ts; here they are mocked
 * so we see only who the service calls them with.
 *
 * Plain English: a submitted pending job alerts the owners; a decision alerts the
 * creator; a pending cancel or real edit alerts the creator; a scheduled job,
 * a no-op save or a failed pre-read alerts nobody, and a save never waits on an alert.
 */

jest.mock('./pending-job-notifications', () => {
  const actual = jest.requireActual<
    typeof import('./pending-job-notifications')
  >('./pending-job-notifications');
  return {
    ...actual,
    alertApproversOfSubmission: jest.fn(),
    alertCreatorOfDecision: jest.fn(),
    alertCreatorOfCancel: jest.fn(),
    alertCreatorOfEdit: jest.fn(),
  };
});

type Result = { data: unknown; error: unknown };

const employee: RequestUser = {
  userId: 'tech-1',
  tenantId: 'tenant-uuid',
  role: Role.EMPLOYEE,
  platformAdmin: false,
  rawJwt: 'jwt',
};
const owner: RequestUser = {
  userId: 'owner-uuid',
  tenantId: 'tenant-uuid',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const JOB_ID = '11111111-1111-4111-8111-111111111111';

const ownDto: CreateJobDto = {
  customerId: 'cust-1',
  serviceLocation: 'Loc',
  skillId: 'skill-uuid-1',
  scheduledStart: '2099-06-22T09:30:00Z',
  technicianId: 'tech-1',
};

const jobRow = (status: string, extra: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  job_number: 'JB-2026-0007',
  tenant_id: 'tenant-uuid',
  customer_id: 'cust-1',
  created_by: 'tech-1',
  technician_id: 'tech-1',
  service_location: 'Loc',
  scheduled_start: '2026-06-22T09:30:00Z',
  scheduled_end: null,
  status,
  completed_at: null,
  current_step: null,
  priority: 'normal',
  description: 'Fix pump',
  notes_for_technician: null,
  created_at: '2026-06-21T00:00:00Z',
  updated_at: '2026-06-21T00:00:00Z',
  skill_id: 'skill-uuid-1',
  skills: null,
  workflow_templates: null,
  ...extra,
});

/** Chainable query node; every filter returns the node, terminals resolve to the given result. */
function chain(terminal: {
  single?: Result;
  maybeSingle?: Result;
  limit?: Result;
  list?: Result;
}) {
  const node: Record<string, unknown> = {};
  for (const m of [
    'select',
    'eq',
    'in',
    'neq',
    'not',
    'or',
    'order',
    'gte',
    'lt',
    'is',
    'gt',
  ]) {
    node[m] = jest.fn(() => node);
  }
  const none: Result = { data: null, error: null };
  node.single = jest.fn().mockResolvedValue(terminal.single ?? none);
  node.maybeSingle = jest.fn().mockResolvedValue(terminal.maybeSingle ?? none);
  node.limit = jest
    .fn()
    .mockResolvedValue(terminal.limit ?? { data: [], error: null });
  node.then = (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
    Promise.resolve(terminal.list ?? { data: [], error: null }).then(ok, fail);
  return node as Record<string, jest.Mock> & { then: unknown };
}

describe('pending-job alerts wired into JobsService (story 5)', () => {
  let service: JobsService;
  let factory: { createAdmin: jest.Mock };
  let txHandler: (
    sql: string,
    params?: unknown[],
  ) => { rows: unknown[]; rowCount?: number };

  beforeEach(async () => {
    jest.clearAllMocks();
    factory = { createAdmin: jest.fn() };
    txHandler = () => ({ rows: [] });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: SupabaseClientFactory, useValue: factory },
        {
          provide: CustomersService,
          useValue: { findOrCreateByPhone: jest.fn() },
        },
        { provide: StorageService, useValue: { presignReadUrl: jest.fn() } },
        {
          provide: PgPoolFactory,
          useValue: {
            withTransaction: (work: (tx: unknown) => unknown) =>
              work({
                query: (sql: string, params?: unknown[]) =>
                  Promise.resolve(txHandler(sql, params)),
              }),
          },
        },
      ],
    }).compile();
    service = module.get(JobsService);
    // The response re-read and mapping are not under test here.
    jest
      .spyOn(service as never, 'refetchWithEmbeds' as never)
      .mockResolvedValue({ id: JOB_ID } as never);
    jest
      .spyOn(service as never, 'toResponse' as never)
      .mockReturnValue({ id: JOB_ID } as never);
  });

  /** Admin client for createJob: the caller's switch, customer, skill, and the technician check. */
  function createAdminWith(rpcRows: unknown[]) {
    const memberships = chain({
      maybeSingle: {
        data: { can_create_jobs: true, job_approval_required: true },
        error: null,
      },
      list: { data: [memberRow('tech-1')], error: null },
    });
    const tables: Record<string, unknown> = {
      memberships,
      customers: chain({
        single: {
          data: { id: 'cust-1', tenant_id: 'tenant-uuid' },
          error: null,
        },
      }),
      skills: chain({
        maybeSingle: { data: { id: 'skill-uuid-1' }, error: null },
      }),
      jobs: chain({
        maybeSingle: { data: jobRow('pending_approval'), error: null },
      }),
    };
    const admin = {
      from: jest.fn((t: string) => {
        if (!(t in tables)) throw new Error(`unexpected table ${t}`);
        return tables[t];
      }),
      rpc: jest.fn().mockResolvedValue({ data: rpcRows, error: null }),
    };
    factory.createAdmin.mockReturnValue(admin);
    return admin;
  }

  /**
   * Admin client for updateJob / decidePendingJob. `before` answers the pre-read of
   * the job (or fails when `preReadError` is set); the RPC answers with `rpcRows`.
   */
  function updateAdminWith(opts: {
    before?: Record<string, unknown> | null;
    preReadError?: unknown;
    rpcRows: unknown[];
  }) {
    const jobs = chain({
      maybeSingle: opts.preReadError
        ? { data: null, error: opts.preReadError }
        : { data: opts.before ?? null, error: null },
    });
    const admin = {
      from: jest.fn(() => jobs),
      rpc: jest.fn().mockResolvedValue({ data: opts.rpcRows, error: null }),
    };
    factory.createAdmin.mockReturnValue(admin);
    return admin;
  }

  const pendingBefore = jobRow('pending_approval');

  // ---- Submission (createJob) ------------------------------------------------

  it('employee submits a pending job: the resolved manager is alerted once, with the new job', async () => {
    createAdminWith([jobRow('pending_approval')]);
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    txHandler = (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('m.role::text')) {
        return {
          rows: [
            {
              user_id: 'tech-1',
              manager_id: 'mgr-1',
              role: 'employee',
              status: 'active',
              disabled: false,
            },
            {
              user_id: 'mgr-1',
              manager_id: null,
              role: 'employee',
              status: 'active',
              disabled: false,
            },
          ],
        };
      }
      return { rows: [] };
    };

    await service.createJob(employee, ownDto);

    expect(alerts.alertApproversOfSubmission).toHaveBeenCalledTimes(1);
    expect(alerts.alertApproversOfSubmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: JOB_ID, status: 'pending_approval' }),
      ['mgr-1'],
      'tech-1',
    );

    // The CAP-4 audit snapshot is written on the RPC's job_submitted row (the
    // create RPC does not emit job_created for a pending job), tenant-scoped.
    const snapshot = queries.find((q) =>
      q.sql.includes('update public.activity_logs'),
    );
    expect(snapshot?.sql).toContain("event_type = 'job_submitted'");
    expect(snapshot?.sql).toContain('tenant_id = $3');
    expect(snapshot?.params).toEqual([JOB_ID, ['mgr-1'], 'tenant-uuid']);
  });

  it('a routing failure after the create commits does not fail the submission', async () => {
    createAdminWith([jobRow('pending_approval')]);
    txHandler = (sql) => {
      if (sql.includes('m.role::text')) throw new Error('lock timeout');
      return { rows: [] };
    };

    await expect(service.createJob(employee, ownDto)).resolves.toBeDefined();

    // No recipient list was resolved, so nobody is told — but the client got
    // its job, so a retry cannot duplicate the submission.
    expect(alerts.alertApproversOfSubmission).not.toHaveBeenCalled();
  });

  it('a tree write that already announced the new approver suppresses the duplicate submission bell', async () => {
    createAdminWith([jobRow('pending_approval')]);
    txHandler = (sql) => {
      if (sql.includes('m.role::text')) {
        return {
          rows: [
            {
              user_id: 'tech-1',
              manager_id: 'mgr-1',
              role: 'employee',
              status: 'active',
              disabled: false,
            },
            {
              user_id: 'mgr-1',
              manager_id: null,
              role: 'employee',
              status: 'active',
              disabled: false,
            },
          ],
        };
      }
      if (sql.includes('select distinct user_id from public.notifications')) {
        return { rows: [{ user_id: 'mgr-1' }] };
      }
      return { rows: [] };
    };

    await service.createJob(employee, ownDto);

    // The re-parent already told the manager; one submission, one bell.
    expect(alerts.alertApproversOfSubmission).not.toHaveBeenCalled();
  });

  it('employee creates a job that goes straight to scheduled: no approver alert', async () => {
    createAdminWith([jobRow('scheduled')]);

    await service.createJob(employee, ownDto);

    expect(alerts.alertApproversOfSubmission).not.toHaveBeenCalled();
  });

  // ---- Decision (decidePendingJob) ------------------------------------------

  const LIVE_TREE = [
    {
      user_id: 'owner-uuid',
      manager_id: null,
      role: 'company_admin',
      status: 'active',
      disabled: false,
    },
    {
      user_id: 'tech-1',
      manager_id: null,
      role: 'employee',
      status: 'active',
      disabled: false,
    },
  ];

  it('owner approves: the creator is alerted with the decision', async () => {
    txHandler = (sql) => {
      // The override right is checked against the live tree inside the tx.
      if (sql.includes('m.role::text')) return { rows: LIVE_TREE };
      if (sql.includes('from public.jobs') && sql.includes('for update')) {
        return { rows: [jobRow('pending_approval')] };
      }
      if (sql.includes('update public.jobs')) {
        return { rowCount: 1, rows: [jobRow('scheduled')] };
      }
      return { rows: [] };
    };
    updateAdminWith({ rpcRows: [jobRow('scheduled')] });

    await service.decidePendingJob(owner, JOB_ID, {
      decision: 'approve',
    } as never);

    expect(alerts.alertCreatorOfDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: JOB_ID }),
      'owner-uuid',
      'approve',
      null,
    );
  });

  it('owner rejects with a reason: the reason is passed through to the alert', async () => {
    txHandler = (sql) => {
      if (sql.includes('m.role::text')) return { rows: LIVE_TREE };
      if (sql.includes('from public.jobs') && sql.includes('for update')) {
        return { rows: [jobRow('pending_approval')] };
      }
      if (sql.includes('update public.jobs')) {
        return { rowCount: 1, rows: [jobRow('rejected')] };
      }
      return { rows: [] };
    };
    updateAdminWith({ rpcRows: [jobRow('rejected')] });

    await service.decidePendingJob(owner, JOB_ID, {
      decision: 'reject',
      reason: 'Duplicate',
    } as never);

    expect(alerts.alertCreatorOfDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: JOB_ID }),
      'owner-uuid',
      'reject',
      'Duplicate',
    );
  });

  // ---- Owner cancel and edit (updateJob) ------------------------------------

  it('owner cancels a pending job: the creator gets the cancel alert, no edit alert', async () => {
    updateAdminWith({
      before: pendingBefore,
      rpcRows: [jobRow('cancelled')],
    });

    await service.updateJob(owner, JOB_ID, {
      status: 'cancelled',
    } as UpdateJobDto);

    expect(alerts.alertCreatorOfCancel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: JOB_ID, status: 'cancelled' }),
      'owner-uuid',
    );
    expect(alerts.alertCreatorOfEdit).not.toHaveBeenCalled();
  });

  it('owner edits a pending job: the edit alert names only the field that really changed', async () => {
    updateAdminWith({
      before: pendingBefore,
      rpcRows: [jobRow('pending_approval', { priority: 'urgent' })],
    });

    await service.updateJob(owner, JOB_ID, {
      priority: 'urgent',
    } as UpdateJobDto);

    expect(alerts.alertCreatorOfEdit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: JOB_ID }),
      'owner-uuid',
      ['priority'],
    );
    expect(alerts.alertCreatorOfCancel).not.toHaveBeenCalled();
  });

  it('owner saves a pending job with no real change: the edit helper gets an empty list and writes nothing', async () => {
    updateAdminWith({
      before: pendingBefore,
      rpcRows: [jobRow('pending_approval')],
    });

    await service.updateJob(owner, JOB_ID, {
      priority: 'normal',
    } as UpdateJobDto);

    // The helper is the gatekeeper: an empty list means no row (see its unit test).
    expect(alerts.alertCreatorOfEdit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'owner-uuid',
      [],
    );
  });

  it('owner edits a scheduled job: no pending-job alert at all', async () => {
    updateAdminWith({
      before: jobRow('scheduled'),
      rpcRows: [jobRow('scheduled', { priority: 'urgent' })],
    });

    await service.updateJob(owner, JOB_ID, {
      priority: 'urgent',
    } as UpdateJobDto);

    expect(alerts.alertCreatorOfEdit).not.toHaveBeenCalled();
    expect(alerts.alertCreatorOfCancel).not.toHaveBeenCalled();
  });

  it('owner cancels a scheduled job: no pending-job cancel alert', async () => {
    updateAdminWith({
      before: jobRow('scheduled'),
      rpcRows: [jobRow('cancelled')],
    });

    await service.updateJob(owner, JOB_ID, {
      status: 'cancelled',
    } as UpdateJobDto);

    expect(alerts.alertCreatorOfCancel).not.toHaveBeenCalled();
  });

  it('a failed pre-read: the edit is refused (fail closed) and nothing is saved or alerted', async () => {
    const rpc = updateAdminWith({
      preReadError: { message: 'read down' },
      rpcRows: [jobRow('pending_approval', { priority: 'urgent' })],
    }).rpc;

    await expect(
      service.updateJob(owner, JOB_ID, { priority: 'urgent' } as UpdateJobDto),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(rpc).not.toHaveBeenCalled();
    expect(alerts.alertCreatorOfEdit).not.toHaveBeenCalled();
    expect(alerts.alertCreatorOfCancel).not.toHaveBeenCalled();
  });

  it('a pre-read that throws: the edit is refused (fail closed) and nothing is saved', async () => {
    const admin = updateAdminWith({
      rpcRows: [jobRow('pending_approval', { priority: 'urgent' })],
    });
    admin.from.mockImplementation(() => {
      throw new Error('connection reset');
    });

    await expect(
      service.updateJob(owner, JOB_ID, { priority: 'urgent' } as UpdateJobDto),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(alerts.alertCreatorOfEdit).not.toHaveBeenCalled();
  });

  it('an alert that never settles does not hold the response back', async () => {
    (alerts.alertCreatorOfEdit as jest.Mock).mockReturnValueOnce(
      new Promise(() => undefined),
    );
    updateAdminWith({
      before: pendingBefore,
      rpcRows: [jobRow('pending_approval', { priority: 'urgent' })],
    });

    const result = await Promise.race([
      service.updateJob(owner, JOB_ID, { priority: 'urgent' } as UpdateJobDto),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('blocked')), 1000),
      ),
    ]);

    expect(result).toBeDefined();
  });
});
