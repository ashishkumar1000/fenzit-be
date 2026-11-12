import { ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { CAN_KEY } from '../common/decorators/can.decorator';
import { JobsController } from './jobs.controller';
import { resolveEmployeeSubmission } from './employee-submission';

type Switches = { can_create_jobs: boolean; job_approval_required: boolean } | null;

/** A memberships read: select().eq().eq().eq().maybeSingle(), recording every filter. */
function membershipRead(result: { data: Switches; error: unknown }) {
  const filters: Array<[string, unknown, unknown]> = [];
  const maybeSingle = jest.fn().mockResolvedValue(result);
  const node: Record<string, unknown> = { maybeSingle };
  const eq = jest.fn((col: string, val: unknown) => {
    filters.push(['eq', col, val]);
    return node;
  });
  Object.assign(node, { eq });
  const select = jest.fn(() => node);
  const from = jest.fn(() => ({ select }));
  return { admin: { from } as unknown as SupabaseClient, from, select, filters, maybeSingle };
}

const employee: RequestUser = {
  userId: 'emp-1',
  tenantId: 'tenant-A',
  role: Role.EMPLOYEE,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const owner: RequestUser = {
  userId: 'owner-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const bodyOf = (e: unknown) => (e as { getResponse(): unknown }).getResponse();

describe('resolveEmployeeSubmission (CAP-2, CAP-3, CAP-4)', () => {
  it('owners get null and no membership read: their jobs are never pending', async () => {
    const read = membershipRead({ data: null, error: null });
    const r = await resolveEmployeeSubmission(read.admin, owner, 'owner-1');
    expect(r).toBeNull();
    expect(read.from).not.toHaveBeenCalled();
  });

  it('reads the caller own active membership in the caller company only', async () => {
    const read = membershipRead({
      data: { can_create_jobs: true, job_approval_required: true },
      error: null,
    });
    await resolveEmployeeSubmission(read.admin, employee, 'emp-1');
    expect(read.from).toHaveBeenCalledWith('memberships');
    expect(read.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'user_id', 'emp-1'],
        ['eq', 'tenant_id', 'tenant-A'],
        ['eq', 'status', 'active'],
      ]),
    );
  });

  it('approval on: the job is pending (CAP-4)', async () => {
    const read = membershipRead({
      data: { can_create_jobs: true, job_approval_required: true },
      error: null,
    });
    expect(await resolveEmployeeSubmission(read.admin, employee, 'emp-1')).toEqual({
      pendingApproval: true,
    });
  });

  it('approval off: the job is not pending and goes straight to assigned (CAP-3)', async () => {
    const read = membershipRead({
      data: { can_create_jobs: true, job_approval_required: false },
      error: null,
    });
    expect(await resolveEmployeeSubmission(read.admin, employee, 'emp-1')).toEqual({
      pendingApproval: false,
    });
  });

  it('creation switched off: refused with a plain reason (CAP-2)', async () => {
    const read = membershipRead({
      data: { can_create_jobs: false, job_approval_required: true },
      error: null,
    });
    const err = await resolveEmployeeSubmission(read.admin, employee, 'emp-1').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(bodyOf(err)).toEqual({
      error_code: ErrorCode.FORBIDDEN,
      message: 'You are not allowed to create jobs. Ask your owner to turn this on.',
    });
  });

  it('no active membership at all is refused the same way (a removed or invited employee)', async () => {
    const read = membershipRead({ data: null, error: null });
    await expect(
      resolveEmployeeSubmission(read.admin, employee, 'emp-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an employee cannot give the job to someone else, and the database is not read', async () => {
    const read = membershipRead({
      data: { can_create_jobs: true, job_approval_required: false },
      error: null,
    });
    const err = await resolveEmployeeSubmission(read.admin, employee, 'emp-2').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(bodyOf(err)).toEqual({
      error_code: ErrorCode.FORBIDDEN,
      message: 'Employees can only create jobs for themselves',
    });
    expect(read.from).not.toHaveBeenCalled();
  });

  it('a failed switch read is a 500, never a silent default', async () => {
    const read = membershipRead({ data: null, error: { code: '08006' } });
    await expect(
      resolveEmployeeSubmission(read.admin, employee, 'emp-1'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('POST /jobs permission (CAP-2)', () => {
  it('both owners (job.write) and employees (job.create_own) may reach it, nobody else by default', () => {
    const handler = JobsController.prototype.createJob;
    expect(Reflect.getMetadata(CAN_KEY, handler)).toEqual(['job.write', 'job.create_own']);
  });
});
