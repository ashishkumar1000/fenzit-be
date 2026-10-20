import { UsersService } from './users.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CustomersService } from '../customers/customers.service';
import { JobsService } from '../jobs/jobs.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';

/**
 * `GET /users/me/access` — the lean access check. The requirement: it answers
 * from the request user alone, so it can run on every foreground without a
 * database round trip, and it reports exactly what the full profile reports
 * for role, company and platform-admin flag.
 */
describe('UsersService.getMyAccess', () => {
  let factory: { createAdmin: jest.Mock };
  let service: UsersService;

  beforeEach(() => {
    factory = { createAdmin: jest.fn() };
    service = new UsersService(
      factory as unknown as SupabaseClientFactory,
      {} as CustomersService,
      {} as JobsService,
    );
  });

  it('reports role, company id and platform-admin flag for a company member', () => {
    const user: RequestUser = {
      userId: 'u-1',
      tenantId: 'tenant-1',
      role: Role.EMPLOYEE,
      platformAdmin: false,
      rawJwt: 'x',
    };

    expect(service.getMyAccess(user)).toEqual({
      role: Role.EMPLOYEE,
      tenant: { id: 'tenant-1' },
      platformAdmin: false,
    });
  });

  it('never queries the database — it answers from the request user alone', () => {
    const user: RequestUser = {
      userId: 'u-1',
      tenantId: 'tenant-1',
      role: Role.COMPANY_ADMIN,
      platformAdmin: false,
      rawJwt: 'x',
    };

    service.getMyAccess(user);

    expect(factory.createAdmin).not.toHaveBeenCalled();
  });

  it('a removed member (no company, no role) gets null role and null company, not a stale one', () => {
    const user: RequestUser = {
      userId: 'u-1',
      tenantId: null,
      role: null,
      platformAdmin: false,
      rawJwt: 'x',
    };

    expect(service.getMyAccess(user)).toEqual({
      role: null,
      tenant: null,
      platformAdmin: false,
    });
  });

  it('a platform admin with no named company keeps the staff flag and no company', () => {
    const user: RequestUser = {
      userId: 'u-staff',
      tenantId: null,
      role: Role.PLATFORM_ADMIN,
      platformAdmin: true,
      rawJwt: 'x',
    };

    expect(service.getMyAccess(user)).toEqual({
      role: Role.PLATFORM_ADMIN,
      tenant: null,
      platformAdmin: true,
    });
  });
});
