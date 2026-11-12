import { InternalServerErrorException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JobsService } from './jobs.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CustomersService } from '../customers/customers.service';
import { StorageService } from '../storage/storage.service';
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
    alertOwnersOfSubmission: jest.fn(),
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
  scheduledStart: '2026-06-22T09:30:00Z',
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

  beforeEach(async () => {
    jest.clearAllMocks();
    factory = { createAdmin: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: SupabaseClientFactory, useValue: factory },
        {
          provide: CustomersService,
          useValue: { findOrCreateByPhone: jest.fn() },
        },
        { provide: StorageService, useValue: { presignReadUrl: jest.fn() } },
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

  it('employee submits a pending job: the owners are alerted once, with the new job', async () => {
    createAdminWith([jobRow('pending_approval')]);

    await service.createJob(employee, ownDto);

    expect(alerts.alertOwnersOfSubmission).toHaveBeenCalledTimes(1);
    expect(alerts.alertOwnersOfSubmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: JOB_ID, status: 'pending_approval' }),
      'tech-1',
    );
  });

  it('employee creates a job that goes straight to scheduled: no owner alert', async () => {
    createAdminWith([jobRow('scheduled')]);

    await service.createJob(employee, ownDto);

    expect(alerts.alertOwnersOfSubmission).not.toHaveBeenCalled();
  });

  // ---- Decision (decidePendingJob) ------------------------------------------

  it('owner approves: the creator is alerted with the decision', async () => {
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
