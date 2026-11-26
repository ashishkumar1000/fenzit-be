import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { CAN_KEY } from '../common/decorators/can.decorator';
import { DecidePendingJobDto } from './dto/decide-pending-job.dto';

/**
 * 24-4 — the job decision is now a NestJS transaction. These pins cover the
 * walk + gate, the guarded write, the activity row, and the unchanged
 * endpoint errors; the real SQL is proven by the live probe and the journey.
 */

jest.mock('./pending-job-notifications', () => ({
  ...jest.requireActual('./pending-job-notifications'),
  alertCreatorOfDecision: jest.fn(),
}));

const TENANT = 'tenant-A';
const EMPLOYEE = '22222222-2222-4222-8222-222222222222';
const MANAGER = '66666666-6666-4666-8666-666666666666';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '77777777-7777-4777-8777-777777777777';
const MANAGER2 = '88888888-8888-4888-8888-888888888888';
const TECH = '99999999-9999-4999-8999-999999999999';
const TECH_MANAGER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = '11111111-1111-4111-8111-111111111111';

const owner: RequestUser = {
  userId: ADMIN,
  tenantId: TENANT,
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const manager: RequestUser = {
  userId: MANAGER,
  tenantId: TENANT,
  role: Role.EMPLOYEE,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const outsider: RequestUser = {
  userId: OUTSIDER,
  tenantId: TENANT,
  role: Role.EMPLOYEE,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const JOB = {
  id: JOB_ID,
  tenant_id: TENANT,
  job_number: 'JB-2026-0001',
  status: 'pending_approval',
  created_by: EMPLOYEE,
  // Deliberately assigned to someone in another branch: the walk must keys off
  // the CREATOR, never the technician.
  technician_id: TECH,
};

const member = (
  userId: string,
  managerId: string | null,
  overrides: Record<string, unknown> = {},
) => ({
  user_id: userId,
  manager_id: managerId,
  role: 'employee',
  status: 'active',
  disabled: false,
  ...overrides,
});

const DEFAULT_TREE = [
  member(ADMIN, null, { role: 'company_admin' }),
  member(MANAGER, null),
  member(EMPLOYEE, MANAGER),
];

/** A service wired to a fake transaction; the tx answers are set per test. */
function serviceWith(
  opts: {
    job?: Record<string, unknown> | null;
    tree?: Array<Record<string, unknown>>;
    updateCount?: number;
  } = {},
) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('attendance_lock_tenant')) return { rows: [] };
      if (sql.includes('from public.jobs') && sql.includes('for update')) {
        return {
          rows: opts.job === null ? [] : [opts.job ?? { ...JOB }],
        };
      }
      if (sql.includes('m.role::text'))
        return { rows: opts.tree ?? DEFAULT_TREE };
      if (sql.includes('update public.jobs')) {
        const count = opts.updateCount ?? 1;
        return {
          rowCount: count,
          rows:
            count === 0 ? [] : [{ ...(opts.job ?? JOB), status: 'scheduled' }],
        };
      }
      if (sql.includes('insert into public.activity_logs')) {
        return { rows: [] };
      }
      throw new Error(`unclassified query: ${sql}`);
    }),
  };
  const pg = {
    withTransaction: (work: (t: unknown) => unknown) => work(tx),
  };
  const factory = { createAdmin: jest.fn(() => ({})) };
  const service = new JobsService(
    factory as never,
    {} as never,
    {} as never,
    pg as never,
  );
  const refetch = jest
    .spyOn(service as never, 'refetchWithEmbeds' as never)
    .mockResolvedValue({ id: JOB_ID } as never);
  const toResponse = jest
    .spyOn(service as never, 'toResponse' as never)
    .mockReturnValue({ id: JOB_ID, status: 'scheduled' } as never);
  return { service, tx, queries, refetch, toResponse };
}

const bodyOf = (e: unknown) => (e as { getResponse(): unknown }).getResponse();

describe('JobsService.decidePendingJob (24-4 transaction)', () => {
  it('the resolved manager approves under one transaction — guarded update, then the activity row', async () => {
    const { service, queries, refetch } = serviceWith();

    await service.decidePendingJob(manager, JOB_ID, { decision: 'approve' });

    const update = queries.find((q) => q.sql.includes('update public.jobs'));
    expect(update?.sql).toContain("status = 'pending_approval'");
    expect(update?.params).toEqual([
      'scheduled',
      MANAGER,
      null,
      JOB_ID,
      TENANT,
    ]);
    const log = queries.find((q) =>
      q.sql.includes('insert into public.activity_logs'),
    );
    expect(log?.params).toEqual([JOB_ID, TENANT, 'job_approved', MANAGER]);
    expect(refetch).toHaveBeenCalled();
  });

  it('a rejection stores the trimmed reason and writes job_rejected', async () => {
    const { service, queries } = serviceWith();
    await service.decidePendingJob(manager, JOB_ID, {
      decision: 'reject',
      reason: '  Wrong address  ',
    });
    const update = queries.find((q) => q.sql.includes('update public.jobs'));
    expect(update?.params?.[0]).toBe('rejected');
    expect(update?.params?.[2]).toBe('Wrong address');
    const log = queries.find((q) =>
      q.sql.includes('insert into public.activity_logs'),
    );
    expect(log?.params?.[2]).toBe('job_rejected');
  });

  it('a whitespace-only reason stores null', async () => {
    const { service, queries } = serviceWith();
    await service.decidePendingJob(manager, JOB_ID, {
      decision: 'reject',
      reason: '   ',
    });
    const update = queries.find((q) => q.sql.includes('update public.jobs'));
    expect(update?.params?.[2]).toBeNull();
  });

  it('any active admin decides regardless of the walk (override)', async () => {
    const { service } = serviceWith({
      // The caller is an active admin in the live tree; the walk itself has
      // nothing to offer. The override must not consult the walk at all.
      tree: [
        member(ADMIN, null, { role: 'company_admin' }),
        member(EMPLOYEE, null),
      ],
    });
    await expect(
      service.decidePendingJob(owner, JOB_ID, { decision: 'approve' }),
    ).resolves.toBeDefined();
  });

  it('an admin promoted while pending decides their own job (admin self)', async () => {
    const adminCreator: RequestUser = {
      ...manager,
      userId: EMPLOYEE,
      role: Role.COMPANY_ADMIN,
    };
    const { service } = serviceWith({
      tree: [member(EMPLOYEE, null, { role: 'company_admin' })],
    });
    await expect(
      service.decidePendingJob(adminCreator, JOB_ID, { decision: 'approve' }),
    ).resolves.toBeDefined();
  });

  it('a member outside the resolved set answers 403 FORBIDDEN and writes nothing', async () => {
    const { service, queries } = serviceWith();
    const err = await service
      .decidePendingJob(outsider, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(bodyOf(err)).toMatchObject({ error_code: ErrorCode.FORBIDDEN });
    expect(
      queries.some((q) => q.sql.includes('insert into public.activity_logs')),
    ).toBe(false);
    expect(queries.some((q) => q.sql.includes('update public.jobs'))).toBe(
      false,
    );
  });

  it('an ownerless company refuses with 409 APPROVER_UNRESOLVED', async () => {
    const { service } = serviceWith({ tree: [member(EMPLOYEE, null)] });
    const err = await service
      .decidePendingJob(manager, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({
      error_code: ErrorCode.APPROVER_UNRESOLVED,
    });
    expect(String(bodyOf(err)['message'])).toContain('add an admin');
  });

  it('a corrupt tree refuses with the tree-specific message', async () => {
    const { service } = serviceWith({
      tree: [
        member(MANAGER, EMPLOYEE, { status: 'deactivated' }),
        member(EMPLOYEE, MANAGER),
      ],
    });
    const err = await service
      .decidePendingJob(manager, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({
      error_code: ErrorCode.APPROVER_UNRESOLVED,
    });
    expect(String(bodyOf(err)['message'])).toContain('reporting line');
  });

  it('a job outside this company answers 404 before the walk', async () => {
    const { service, queries } = serviceWith({ job: null });
    const err = await service
      .decidePendingJob(manager, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(bodyOf(err)).toMatchObject({
      error_code: ErrorCode.RESOURCE_NOT_FOUND,
    });
    expect(queries.some((q) => q.sql.includes('m.role::text'))).toBe(false);
  });

  it('a job that already left pending answers 409 JOB_NOT_PENDING before the walk', async () => {
    const { service, queries } = serviceWith({
      job: { ...JOB, status: 'scheduled' },
    });
    const err = await service
      .decidePendingJob(manager, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({
      error_code: ErrorCode.JOB_NOT_PENDING,
    });
    expect(queries.some((q) => q.sql.includes('m.role::text'))).toBe(false);
  });

  it('a lost race on the guarded UPDATE answers 409 JOB_NOT_PENDING', async () => {
    const { service, queries } = serviceWith({ updateCount: 0 });
    const err = await service
      .decidePendingJob(manager, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({
      error_code: ErrorCode.JOB_NOT_PENDING,
    });
    expect(
      queries.some((q) => q.sql.includes('insert into public.activity_logs')),
    ).toBe(false);
  });

  it('a manager above the resolved approver is refused and writes nothing', async () => {
    // EMPLOYEE → MANAGER → MANAGER2. MANAGER2 can read the branch but is not
    // the resolved approver.
    const tree = [
      member(ADMIN, null, { role: 'company_admin' }),
      member(MANAGER2, null),
      member(MANAGER, MANAGER2),
      member(EMPLOYEE, MANAGER),
    ];
    const { service, queries } = serviceWith({ tree });

    const err = await service
      .decidePendingJob({ ...manager, userId: MANAGER2 }, JOB_ID, {
        decision: 'approve',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(bodyOf(err)).toMatchObject({ error_code: ErrorCode.FORBIDDEN });
    expect(queries.some((q) => q.sql.includes('update public.jobs'))).toBe(
      false,
    );

    // ...while the resolved approver still decides it.
    await expect(
      service.decidePendingJob(manager, JOB_ID, { decision: 'approve' }),
    ).resolves.toBeDefined();
  });

  it('routes on the creator, never the assigned technician', async () => {
    const tree = [
      member(ADMIN, null, { role: 'company_admin' }),
      member(TECH_MANAGER, null),
      member(TECH, TECH_MANAGER),
      member(MANAGER, null),
      member(EMPLOYEE, MANAGER),
    ];
    const { service } = serviceWith({ tree });

    // The technician's manager would be the approver if routing used the
    // assignee. It must not.
    const wrong = await service
      .decidePendingJob({ ...manager, userId: TECH_MANAGER }, JOB_ID, {
        decision: 'approve',
      })
      .catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(ForbiddenException);

    await expect(
      service.decidePendingJob(manager, JOB_ID, { decision: 'approve' }),
    ).resolves.toBeDefined();
  });

  it('a disabled admin no longer holds the override', async () => {
    const disabled = DEFAULT_TREE.map((row) =>
      row.user_id === ADMIN ? { ...row, disabled: true } : row,
    );
    const { service } = serviceWith({ tree: disabled });

    const err = await service
      .decidePendingJob(owner, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it('a caller demoted after the token was issued decides nothing (live tree wins)', async () => {
    const demoted = DEFAULT_TREE.map((row) =>
      row.user_id === ADMIN ? { ...row, role: 'employee' } : row,
    );
    const { service } = serviceWith({ tree: demoted });

    // owner still carries role=company_admin from the token.
    const err = await service
      .decidePendingJob(owner, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(bodyOf(err)).toMatchObject({ error_code: ErrorCode.FORBIDDEN });
  });

  it('a pending job with no creator on file refuses a non-admin with the no-creator reason', async () => {
    const { service } = serviceWith({ job: { ...JOB, created_by: null } });

    const err = await service
      .decidePendingJob(manager, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({
      error_code: ErrorCode.APPROVER_UNRESOLVED,
    });
    expect(String(bodyOf(err)['message'])).toContain('no creator on file');
  });

  it('a pending job with no creator on file stays decidable by an admin', async () => {
    const { service } = serviceWith({ job: { ...JOB, created_by: null } });

    await expect(
      service.decidePendingJob(owner, JOB_ID, { decision: 'approve' }),
    ).resolves.toBeDefined();
  });

  it('takes the shared tenant lock, then the job row lock, before the walk and the guarded write', async () => {
    const { service, queries } = serviceWith();

    await service.decidePendingJob(manager, JOB_ID, { decision: 'approve' });

    const lock = queries.find((q) => q.sql.includes('attendance_lock_tenant'));
    expect(lock?.sql).toContain('false');
    expect(lock?.params).toEqual([TENANT]);

    const read = queries.find((q) => q.sql.includes('from public.jobs'));
    expect(read?.sql).toContain('for update');
    expect(read?.params).toEqual([JOB_ID, TENANT]);

    const update = queries.find((q) => q.sql.includes('update public.jobs'));
    expect(update?.sql).toContain("status = 'pending_approval'");

    // Serialisation rests on this order: lock → row read → walk → guarded write.
    expect(queries.indexOf(lock!)).toBeLessThan(queries.indexOf(read!));
    expect(queries.indexOf(read!)).toBeLessThan(queries.indexOf(update!));
  });

  it('a caller with no company is refused before any database call', async () => {
    const { service, tx } = serviceWith();
    const err = await service
      .decidePendingJob({ ...owner, tenantId: null }, JOB_ID, {
        decision: 'approve',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(bodyOf(err)).toMatchObject({
      error_code: ErrorCode.VALIDATION_ERROR,
    });
    expect(tx.query).not.toHaveBeenCalled();
  });
});

describe('POST /jobs/:id/approval — route contract', () => {
  it('stays gated by the tree-derived job.approve permission', () => {
    const handler = (
      JobsController.prototype as unknown as Record<string, unknown>
    )['decidePendingJob'] as object;
    const needed = Reflect.getMetadata(CAN_KEY, handler) as
      string[] | undefined;

    expect(needed).toEqual(['job.approve']);
  });
});

describe('DecidePendingJobDto (request rules)', () => {
  const check = async (body: Record<string, unknown>) =>
    validate(plainToInstance(DecidePendingJobDto, body));

  it.each(['approve', 'reject'])('accepts decision %s', async (decision) => {
    expect(await check({ decision })).toHaveLength(0);
  });

  it.each([
    ['an unknown word', 'cancel'],
    ['the wrong case', 'Approve'],
    ['a missing decision', undefined],
    ['a number', 1],
  ])('refuses %s', async (_label, decision) => {
    expect((await check({ decision })).length).toBeGreaterThan(0);
  });

  it('accepts a reason of exactly 500 characters and refuses 501', async () => {
    expect(
      await check({ decision: 'reject', reason: 'x'.repeat(500) }),
    ).toHaveLength(0);
    expect(
      (await check({ decision: 'reject', reason: 'x'.repeat(501) })).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a reason that is not text', async () => {
    expect(
      (await check({ decision: 'reject', reason: 42 })).length,
    ).toBeGreaterThan(0);
  });
});
