import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StorageService } from '../storage/storage.service';
import { MembersService } from './members.service';
import { MembersController } from './members.controller';
import { JobSettingsDto } from './dto/job-settings.dto';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import { permissionsFor } from '../common/permissions/permissions';
import { CAN_KEY } from '../common/decorators/can.decorator';
import { listCompanyMembers } from '../common/members/company-members';

const owner: RequestUser = {
  userId: 'owner-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

function serviceWithRpc(result: { data: unknown; error: unknown }) {
  const rpc = jest.fn().mockResolvedValue(result);
  const factory = {
    createAdmin: jest.fn(() => ({ rpc })),
  } as unknown as jest.Mocked<SupabaseClientFactory>;
  const service = new MembersService(
    factory,
    {} as unknown as StorageService,
  );
  return { service, rpc };
}

const ok = (canCreate: boolean, approval: boolean) => ({
  data: [
    {
      member_id: 'm-1',
      can_create_jobs: canCreate,
      job_approval_required: approval,
    },
  ],
  error: null,
});

describe('MembersService.setJobSettings', () => {
  it('sends the caller company from the session, never from the request body', async () => {
    const { service, rpc } = serviceWithRpc(ok(true, false));
    await service.setJobSettings(owner, 'emp-1', {
      canCreateJobs: true,
      jobApprovalRequired: false,
    });
    expect(rpc).toHaveBeenCalledWith('set_member_job_settings', {
      p_caller: 'owner-1',
      p_tenant_id: 'tenant-A',
      p_member_user_id: 'emp-1',
      p_can_create_jobs: true,
      p_job_approval_required: false,
    });
  });

  it('returns the values the database stored, not the values asked for', async () => {
    const { service } = serviceWithRpc(ok(false, true));
    const r = await service.setJobSettings(owner, 'emp-1', {
      canCreateJobs: true,
      jobApprovalRequired: false,
    });
    expect(r).toEqual({
      userId: 'emp-1',
      canCreateJobs: false,
      jobApprovalRequired: true,
    });
  });

  it('a database refusal of the caller is a 403 with a plain reason', async () => {
    const { service } = serviceWithRpc({
      data: null,
      error: { code: 'PT403', hint: 'FORBIDDEN' },
    });
    await expect(
      service.setJobSettings(owner, 'emp-1', { canCreateJobs: true, jobApprovalRequired: true }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('a missing member is a 404', async () => {
    const { service } = serviceWithRpc({
      data: null,
      error: { code: 'PT404', hint: 'RESOURCE_NOT_FOUND' },
    });
    await expect(
      service.setJobSettings(owner, 'emp-1', { canCreateJobs: true, jobApprovalRequired: true }),
    ).rejects.toThrow(NotFoundException);
  });

  it('setting job switches on a non-employee is a 400 that names NOT_AN_EMPLOYEE', async () => {
    const { service } = serviceWithRpc({
      data: null,
      error: { code: 'PT400', hint: 'NOT_AN_EMPLOYEE' },
    });
    const err = await service
      .setJobSettings(owner, 'viewer-1', { canCreateJobs: true, jobApprovalRequired: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual({
      error_code: ErrorCode.NOT_AN_EMPLOYEE,
      message: 'Job settings can only be set for an Employee',
    });
  });

  it('a generic bad request from the database stays a plain validation error', async () => {
    const { service } = serviceWithRpc({
      data: null,
      error: { code: 'PT400', hint: 'VALIDATION_ERROR' },
    });
    const err = await service
      .setJobSettings(owner, 'emp-1', { canCreateJobs: true, jobApprovalRequired: true })
      .catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      error_code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('an unexpected database error is a 500, never a made-up success', async () => {
    const { service } = serviceWithRpc({
      data: null,
      error: { code: '08006', message: 'connection lost' },
    });
    await expect(
      service.setJobSettings(owner, 'emp-1', { canCreateJobs: true, jobApprovalRequired: true }),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('an empty database answer is a 500, not a success with guessed values', async () => {
    const { service } = serviceWithRpc({ data: [], error: null });
    await expect(
      service.setJobSettings(owner, 'emp-1', { canCreateJobs: true, jobApprovalRequired: true }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});

describe('JobSettingsDto validation', () => {
  const check = async (body: Record<string, unknown>) =>
    validate(plainToInstance(JobSettingsDto, body));

  it('accepts two real booleans', async () => {
    expect(await check({ canCreateJobs: true, jobApprovalRequired: false })).toHaveLength(0);
  });

  it.each([
    ['a string "true"', { canCreateJobs: 'true', jobApprovalRequired: true }],
    ['the number 1', { canCreateJobs: 1, jobApprovalRequired: true }],
    ['null', { canCreateJobs: null, jobApprovalRequired: true }],
    ['a missing field', { canCreateJobs: true }],
    ['an empty body', {}],
  ])('rejects %s', async (_label, body) => {
    expect((await check(body)).length).toBeGreaterThan(0);
  });
});

describe('job-settings permission', () => {
  it('the company admin of a company holds it', () => {
    expect(permissionsFor(Role.COMPANY_ADMIN).has('member.job_settings')).toBe(true);
  });

  it('a platform admin does not hold it, even though they hold the other admin permissions', () => {
    expect(permissionsFor(Role.PLATFORM_ADMIN).has('member.job_settings')).toBe(false);
  });

  it('employees and viewers do not hold it', () => {
    expect(permissionsFor(Role.EMPLOYEE).has('member.job_settings')).toBe(false);
    expect(permissionsFor(Role.VIEWER).has('member.job_settings')).toBe(false);
  });

  it('the route requires exactly that permission', () => {
    const handler = MembersController.prototype.setJobSettings;
    expect(Reflect.getMetadata(CAN_KEY, handler)).toEqual(['member.job_settings']);
  });
});

describe('company member list carries the job switches', () => {
  function admin(rows: unknown[]) {
    const builder: Record<string, unknown> = {};
    for (const name of ['select', 'eq', 'neq', 'order']) {
      builder[name] = jest.fn(() => builder);
    }
    builder['then'] = (resolve: (v: unknown) => void) =>
      resolve({ data: rows, error: null });
    return { from: jest.fn(() => builder) } as never;
  }

  const row = (overrides: Record<string, unknown>) => ({
    user_id: 'u-1',
    role: 'employee',
    status: 'active',
    employee_code: 'EMP-001',
    created_at: '2026-11-01T00:00:00Z',
    can_create_jobs: false,
    job_approval_required: true,
    users: {
      name: 'Ravi',
      country_code: '+91',
      phone_number: '9876543210',
      disabled: false,
      avatar_key: null,
    },
    ...overrides,
  });

  it('maps the stored switches onto canCreateJobs and jobApprovalRequired', async () => {
    const [m] = await listCompanyMembers(
      admin([row({ can_create_jobs: true, job_approval_required: false })]),
      'tenant-A',
    );
    expect(m).toMatchObject({ canCreateJobs: true, jobApprovalRequired: false });
  });

  it('shows the defaults for an employee who was never set', async () => {
    const [m] = await listCompanyMembers(admin([row({})]), 'tenant-A');
    expect(m).toMatchObject({ canCreateJobs: false, jobApprovalRequired: true });
  });
});
