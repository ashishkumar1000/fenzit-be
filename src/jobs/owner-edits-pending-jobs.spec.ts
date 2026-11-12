import {
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { JobsService } from './jobs.service';
import { UpdateJobDto } from './dto/update-job.dto';

/**
 * Owner edits and cancels (CAP-5 edits, story 4). The rules live in the database
 * (update_job_with_log); these tests pin how the service turns each refusal into
 * the right HTTP status and message, and what it sends to the database.
 *
 * Plain English: a pending job's assignee is locked, a rejected or finished job is
 * read-only, and a database error never leaks its raw text.
 */

const owner: RequestUser = {
  userId: 'owner-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const ROW = [{ id: JOB_ID, status: 'pending_approval' }];

// The pre-read (story 5) and the employee-creator check (story 4 guard) both
// read through from(); a pending job with no creator is the default fixture.
function serviceWith(
  rpcResult: { data: unknown; error: unknown },
  preRead: Record<string, unknown> = {
    id: JOB_ID,
    status: 'pending_approval',
    created_by: null,
  },
) {
  const rpc = jest.fn().mockResolvedValue(rpcResult);
  const from = jest.fn(() => {
    const maybeSingle = jest
      .fn()
      .mockResolvedValue({ data: preRead, error: null });
    const eq: jest.Mock = jest.fn(() => ({ eq, maybeSingle }));
    return { select: jest.fn(() => ({ eq })) };
  });
  const factory = { createAdmin: jest.fn(() => ({ rpc, from })) };
  const service = new JobsService(factory as never, {} as never, {} as never);
  jest
    .spyOn(service as never, 'refetchWithEmbeds' as never)
    .mockResolvedValue({ id: JOB_ID } as never);
  jest
    .spyOn(service as never, 'toResponse' as never)
    .mockReturnValue({ id: JOB_ID, status: 'pending_approval' } as never);
  return { service, rpc };
}

const bodyOf = (e: unknown) => (e as { getResponse(): unknown }).getResponse();

describe('JobsService.updateJob: owner edits to pending and other jobs (story 4)', () => {
  it('sends a field edit to the database as an edit, not a cancel', async () => {
    const { service, rpc } = serviceWith({ data: ROW, error: null });
    await service.updateJob(owner, JOB_ID, {
      priority: 'urgent',
    } as UpdateJobDto);
    expect(rpc).toHaveBeenCalledWith(
      'update_job_with_log',
      expect.objectContaining({
        p_job_id: JOB_ID,
        p_tenant_id: 'tenant-A',
        p_actor_id: 'owner-1',
        p_cancel: false,
        p_priority: 'urgent',
      }),
    );
  });

  it('sends a cancel as p_cancel true (pending or scheduled, the database decides which)', async () => {
    const { service, rpc } = serviceWith({ data: ROW, error: null });
    await service.updateJob(owner, JOB_ID, { status: 'cancelled' } as never);
    const args = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args[1]).toMatchObject({ p_cancel: true });
  });

  it('a pending job whose assignee is locked: 422 with the plain reason, not the schedule message', async () => {
    const { service } = serviceWith({
      data: null,
      error: { code: 'PT422', hint: 'PENDING_ASSIGNEE_LOCKED' },
    });
    const err = await service
      .updateJob(owner, JOB_ID, { priority: 'urgent' } as UpdateJobDto)
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(422);
    expect(bodyOf(err)).toMatchObject({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'A pending job stays with its creator until it is approved',
    });
  });

  it('an inverted schedule window (no hint): 422 with the schedule message', async () => {
    const { service } = serviceWith({
      data: null,
      error: { code: 'PT422', hint: null },
    });
    const err = await service
      .updateJob(owner, JOB_ID, { priority: 'urgent' } as UpdateJobDto)
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(422);
    expect(bodyOf(err)).toMatchObject({
      message: 'scheduledEnd must not be before scheduledStart',
    });
  });

  it('a rejected, cancelled or completed job: 409 JOB_NOT_MODIFIABLE', async () => {
    const { service } = serviceWith({
      data: null,
      error: { code: 'PT409', hint: 'JOB_NOT_MODIFIABLE' },
    });
    const err = await service
      .updateJob(owner, JOB_ID, { priority: 'urgent' } as UpdateJobDto)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(409);
    expect(bodyOf(err)).toMatchObject({
      error_code: ErrorCode.JOB_NOT_MODIFIABLE,
    });
  });

  it('a job in another company, or missing: the empty result is 404, never a silent success', async () => {
    const { service } = serviceWith({ data: [], error: null });
    await expect(
      service.updateJob(owner, JOB_ID, { priority: 'urgent' } as UpdateJobDto),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an unexpected database error is a 500 that does not leak the raw message', async () => {
    const { service } = serviceWith({
      data: null,
      error: {
        code: 'XX000',
        hint: null,
        message: 'relation "jobs" secret detail',
      },
    });
    const err = await service
      .updateJob(owner, JOB_ID, { priority: 'urgent' } as UpdateJobDto)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(JSON.stringify(bodyOf(err))).not.toContain('secret detail');
  });

  it('an empty patch never reaches the database', async () => {
    const { service, rpc } = serviceWith({ data: ROW, error: null });
    const err = await service
      .updateJob(owner, JOB_ID, {})
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('JobsService.updateJob: a decided employee job takes no owner edit (CAP-5 guard)', () => {
  // Table-aware admin: the job pre-read and the creator's membership role.
  function serviceForDecided(status: string, creatorRole: string | null) {
    const rpc = jest.fn().mockResolvedValue({
      data: [{ id: JOB_ID, status }],
      error: null,
    });
    const from = jest.fn((table: string) => {
      const maybeSingle = jest.fn().mockResolvedValue(
        table === 'jobs'
          ? { data: { id: JOB_ID, status, created_by: 'emp-1' }, error: null }
          : { data: creatorRole === null ? null : { role: creatorRole }, error: null },
      );
      const eq: jest.Mock = jest.fn(() => ({ eq, maybeSingle }));
      return { select: jest.fn(() => ({ eq })) };
    });
    const factory = { createAdmin: jest.fn(() => ({ rpc, from })) };
    const service = new JobsService(factory as never, {} as never, {} as never);
    jest
      .spyOn(service as never, 'refetchWithEmbeds' as never)
      .mockResolvedValue({ id: JOB_ID } as never);
    jest
      .spyOn(service as never, 'toResponse' as never)
      .mockReturnValue({ id: JOB_ID } as never);
    return { service, rpc };
  }

  it.each(['scheduled', 'completed', 'rejected'])(
    'an edit to an employee job that is %s: 409 JOB_NOT_MODIFIABLE, nothing saved',
    async (status) => {
      const { service, rpc } = serviceForDecided(status, 'employee');
      await expect(
        service.updateJob(owner, JOB_ID, { priority: 'urgent' } as UpdateJobDto),
      ).rejects.toBeInstanceOf(HttpException);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('a cancel of a decided employee job is not an edit, so it still goes through', async () => {
    const { service, rpc } = serviceForDecided('scheduled', 'employee');
    await service.updateJob(owner, JOB_ID, {
      status: 'cancelled',
    } as UpdateJobDto);
    expect(rpc).toHaveBeenCalledWith(
      'update_job_with_log',
      expect.objectContaining({ p_cancel: true }),
    );
  });

  it('an owner-created job is still editable after it is scheduled', async () => {
    const { service, rpc } = serviceForDecided('scheduled', 'company_admin');
    await service.updateJob(owner, JOB_ID, { priority: 'urgent' } as UpdateJobDto);
    expect(rpc).toHaveBeenCalled();
  });
});
