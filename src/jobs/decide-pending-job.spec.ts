import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { CAN_KEY } from '../common/decorators/can.decorator';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { DecidePendingJobDto } from './dto/decide-pending-job.dto';

const owner: RequestUser = {
  userId: 'owner-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const JOB_ID = '11111111-1111-4111-8111-111111111111';

/** A service wired to a stubbed admin client; the RPC result is set per test. */
function serviceWith(rpcResult: { data: unknown; error: unknown }) {
  const rpc = jest.fn().mockResolvedValue(rpcResult);
  const factory = { createAdmin: jest.fn(() => ({ rpc })) };
  const service = new JobsService(factory as never, {} as never, {} as never);
  const refetch = jest
    .spyOn(service as never as Record<string, unknown>, 'refetchWithEmbeds' as never)
    .mockResolvedValue({ id: JOB_ID } as never);
  const toResponse = jest
    .spyOn(service as never as Record<string, unknown>, 'toResponse' as never)
    .mockReturnValue({ id: JOB_ID, status: 'scheduled' } as never);
  return { service, rpc, factory, refetch, toResponse };
}

const bodyOf = (e: unknown) => (e as { getResponse(): unknown }).getResponse();

const DECISION_ROW = [{ id: JOB_ID, status: 'scheduled' }];

describe('JobsService.decidePendingJob (CAP-5 decisions)', () => {
  it('sends the caller, company, job, decision and reason to the decision function', async () => {
    const { service, rpc } = serviceWith({ data: DECISION_ROW, error: null });
    await service.decidePendingJob(owner, JOB_ID, {
      decision: 'reject',
      reason: 'Wrong address',
    });
    expect(rpc).toHaveBeenCalledWith('decide_pending_job', {
      p_caller: 'owner-1',
      p_tenant_id: 'tenant-A',
      p_job_id: JOB_ID,
      p_decision: 'reject',
      p_reason: 'Wrong address',
    });
  });

  it('sends a null reason when none is given (approve, or reject without a reason)', async () => {
    const { service, rpc } = serviceWith({ data: DECISION_ROW, error: null });
    await service.decidePendingJob(owner, JOB_ID, { decision: 'approve' });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_decision: 'approve', p_reason: null });
  });

  it('returns the job after the decision, read back with its embeds', async () => {
    const { service, refetch, toResponse } = serviceWith({
      data: DECISION_ROW,
      error: null,
    });
    const out = await service.decidePendingJob(owner, JOB_ID, { decision: 'approve' });
    expect(refetch).toHaveBeenCalledWith(expect.anything(), JOB_ID, 'tenant-A', DECISION_ROW[0]);
    expect(toResponse).toHaveBeenCalled();
    expect(out).toEqual({ id: JOB_ID, status: 'scheduled' });
  });

  it('a caller with no company set up is refused before any database call', async () => {
    const { service, rpc, factory } = serviceWith({ data: DECISION_ROW, error: null });
    const err = await service
      .decidePendingJob({ ...owner, tenantId: null } as never, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(bodyOf(err)).toMatchObject({ error_code: ErrorCode.VALIDATION_ERROR });
    expect(factory.createAdmin).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['already decided (JOB_NOT_PENDING)', { code: 'PT409', hint: ErrorCode.JOB_NOT_PENDING }, ConflictException, ErrorCode.JOB_NOT_PENDING],
    ['not the owner (PT403)', { code: 'PT403', hint: 'FORBIDDEN' }, ForbiddenException, ErrorCode.FORBIDDEN],
    ['job not in this company (PT404)', { code: 'PT404', hint: 'RESOURCE_NOT_FOUND' }, NotFoundException, ErrorCode.RESOURCE_NOT_FOUND],
    ['bad input (PT400)', { code: 'PT400', hint: 'VALIDATION_ERROR' }, BadRequestException, ErrorCode.VALIDATION_ERROR],
  ])('maps %s to the right status and error code', async (_label, rpcError, expected, code) => {
    const { service } = serviceWith({ data: null, error: rpcError });
    const err = await service
      .decidePendingJob(owner, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(expected);
    expect(bodyOf(err)).toMatchObject({ error_code: code });
  });

  it('a PT409 with some other hint is not a conflict: it is a 500', async () => {
    const { service } = serviceWith({
      data: null,
      error: { code: 'PT409', hint: 'DUPLICATE_RESOURCE' },
    });
    await expect(
      service.decidePendingJob(owner, JOB_ID, { decision: 'approve' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('an unexpected database error becomes a 500 that does not leak the raw message', async () => {
    const { service } = serviceWith({
      data: null,
      error: { code: 'XX000', hint: null, message: 'relation "jobs" secret detail' },
    });
    const err = await service
      .decidePendingJob(owner, JOB_ID, { decision: 'approve' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(JSON.stringify(bodyOf(err))).not.toContain('secret detail');
    expect(bodyOf(err)).toMatchObject({ error_code: ErrorCode.INTERNAL_SERVER_ERROR });
  });

  it('an empty result is a 500, never a silent success', async () => {
    const { service } = serviceWith({ data: [], error: null });
    await expect(
      service.decidePendingJob(owner, JOB_ID, { decision: 'approve' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
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
    expect(await check({ decision: 'reject', reason: 'x'.repeat(500) })).toHaveLength(0);
    expect((await check({ decision: 'reject', reason: 'x'.repeat(501) })).length).toBeGreaterThan(0);
  });

  it('refuses a reason that is not text', async () => {
    expect((await check({ decision: 'reject', reason: 42 })).length).toBeGreaterThan(0);
  });

  it('accepts a missing reason (optional, even when rejecting)', async () => {
    expect(await check({ decision: 'reject' })).toHaveLength(0);
  });
});

describe('POST /jobs/:id/approval permission', () => {
  it('is restricted to the job.approve permission (owners only)', () => {
    expect(
      Reflect.getMetadata(CAN_KEY, JobsController.prototype.decidePendingJob),
    ).toEqual(['job.approve']);
  });
});
