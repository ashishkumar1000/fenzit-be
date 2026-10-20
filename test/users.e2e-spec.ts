/**
 * Users (e2e) — route-level coverage for `GET /api/v1/users/me`.
 *
 * The service branch logic is fully unit-covered (`users.service.spec.ts`);
 * this spec pins what those tests cannot see: the Fastify route registration,
 * JWT auth, the permissions guard, the global validation pipe (the 422 contract),
 * and the company admin / employee profile contracts over the wire — including the
 * additive `customerCount` field that arrived with the Home count-lines
 * change (2026-09-20; fenzit-be commit 88e08aa).
 *
 * Supabase is mocked at the `SupabaseClientFactory` boundary with a universal
 * thenable builder: every terminal chain resolves empty, and the two
 * `.single()` reads (own user row, tenant row) resolve fixtures keyed by
 * table — enough for the full owner query fan-out (profile, tenant,
 * technicians, customers, jobs, job counts, customer count) to run its real
 * code paths without any per-query stubs.
 */
import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation-pipe-options';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';
import { Role } from '../src/common/enums/role.enum';
import { accessToken, withPeople } from './helpers/auth-test-utils';

describe('Users (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;

  const TENANT_ID = '33333333-3333-4333-8333-333333333333';
  const OWNER_ID = '11111111-1111-4111-8111-111111111111';
  const TECH_ID = '22222222-2222-4222-8222-222222222222';
  // A signed-in person who has not set up a company yet.
  const NEW_ID = '44444444-4444-4444-8444-444444444444';

  const ownerRow = {
    id: OWNER_ID,
    name: 'Kumar Selvan',
    country_code: '+91',
    phone_number: '9000000000',
  };

  // The employee code and status now live on the membership, not the user.
  const membershipRow = { employee_code: 'EMP-001', status: 'active' };

  const tenantRow = {
    id: TENANT_ID,
    company_name: 'Fenzit Services',
    gstin: null,
    address: null,
    state_code: 'TN',
    upi_vpa: null,
  };

  // Per-test override — the pre-onboarding and technician tests reshape this.
  let ownUserRow: Record<string, unknown> = ownerRow;

  beforeAll(async () => {
    const mockFrom = jest.fn().mockImplementation((table: string) => {
      // 15-7: the technician profile reads the attendance access view; the
      // generic builder below has no maybeSingle, so serve it a dedicated
      // chain whose read resolves to "no row" (profile maps that to the
      // attendance-free default).
      if (table === 'attendance_access_state') {
        const viewQb: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'maybeSingle']) {
          viewQb[method] = jest.fn().mockReturnValue(viewQb);
        }
        viewQb.then = (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: null });
        return viewQb;
      }
      const builder: Record<string, unknown> = {};
      for (const method of [
        'select',
        'eq',
        'neq',
        'gte',
        'gt',
        'lte',
        'lt',
        'in',
        'or',
        'order',
        'limit',
        'range',
        'not',
        'is',
      ]) {
        builder[method] = jest.fn().mockReturnValue(builder);
      }
      builder.maybeSingle = jest.fn().mockImplementation(async () => ({
        data: table === 'memberships' ? membershipRow : null,
        error: null,
      }));
      builder.single = jest.fn().mockImplementation(async () => {
        if (table === 'users') return { data: ownUserRow, error: null };
        if (table === 'tenants') return { data: tenantRow, error: null };
        return {
          data: null,
          error: { code: 'PGRST116', message: `no ${table} row` },
        };
      });
      // Terminal `await` on any chain — every head-count/list resolves empty.
      builder.then = (resolve: (v: unknown) => void) =>
        resolve({ data: [], error: null, count: null });
      return builder;
    });

    const moduleFixture: TestingModule = await withPeople(
      Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(SupabaseClientFactory)
        .useValue({
          create: jest.fn(),
          createAdmin: jest.fn(() => ({ from: mockFrom })),
        }),
      [
        { userId: OWNER_ID, tenantId: TENANT_ID, role: Role.COMPANY_ADMIN },
        { userId: TECH_ID, tenantId: TENANT_ID, role: Role.EMPLOYEE },
        { userId: NEW_ID, tenantId: null, role: null },
      ],
    ).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  function jwt(who: 'owner' | 'technician' | 'new') {
    const ids = { owner: OWNER_ID, technician: TECH_ID, new: NEW_ID };
    return accessToken(jwtService, ids[who]);
  }

  describe('GET /api/v1/users/me/access', () => {
    const getAccess = (who: 'owner' | 'technician' | 'new') =>
      app.inject({
        method: 'GET',
        url: '/api/v1/users/me/access',
        headers: { authorization: `Bearer ${jwt(who)}` },
      });

    it('owner — 200 with role, company id and platform-admin flag only', async () => {
      ownUserRow = ownerRow;

      const response = await getAccess('owner');

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({
        role: 'company_admin',
        tenant: { id: TENANT_ID },
        platformAdmin: false,
      });
    });

    it('agrees with GET /users/me on role and company for the same person', async () => {
      ownUserRow = ownerRow;

      const [access, profile] = await Promise.all([
        getAccess('owner'),
        app.inject({
          method: 'GET',
          url: '/api/v1/users/me',
          headers: { authorization: `Bearer ${jwt('owner')}` },
        }),
      ]);

      const a = JSON.parse(access.body);
      const p = JSON.parse(profile.body);
      expect(a.role).toBe(p.role);
      expect(a.tenant.id).toBe(p.tenant.id);
      expect(a.platformAdmin).toBe(p.platformAdmin);
    });

    it('employee — 200 with the employee role and the same company', async () => {
      ownUserRow = { ...ownerRow, id: TECH_ID };

      const response = await getAccess('technician');

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        role: 'employee',
        tenant: { id: TENANT_ID },
        platformAdmin: false,
      });
    });

    it('person with no company — 200 with null role and null tenant, never a company id', async () => {
      ownUserRow = { ...ownerRow, id: NEW_ID };

      const response = await getAccess('new');

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        role: null,
        tenant: null,
        platformAdmin: false,
      });
    });

    it('returns 401 without a JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/access',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/users/me', () => {
    it('company admin — 200 with the full profile contract, customerCount included', async () => {
      ownUserRow = ownerRow;

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${jwt('owner')}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.role).toBe('company_admin');
      expect(body.platformAdmin).toBe(false);
      expect(body.tenant.companyName).toBe('Fenzit Services');
      // The additive field this spec exists to pin over the wire: an exact
      // tenant-wide total, present as a number even when it is zero.
      expect(body).toHaveProperty('customerCount');
      expect(typeof body.customerCount).toBe('number');
      expect(body.technicianCount).toBe(0);
      expect(body.technicians).toEqual([]);
      expect(body.customers).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
      expect(body.jobs).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
      expect(Object.keys(body.jobCounts).sort()).toEqual([
        'cancelled',
        'completed',
        'overdue',
        'today',
        'upcoming',
      ]);
      // 2026-09-30 — the owner branch carries the attendance mirror over the
      // wire (the tenant flag gates the Home entry point). The mock's view
      // read resolves no row → the attendance-free default.
      expect(body.attendance).toEqual({
        attendanceEnabled: false,
        attendanceAccess: 'none',
        attendanceStartDate: null,
        onboardedAt: null,
        pendingLeaveRequests: 0,
      });
    });

    it('employee — 200 with the role-specific shape (skills, no customers)', async () => {
      ownUserRow = { ...ownerRow, id: TECH_ID };

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${jwt('technician')}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.role).toBe('employee');
      expect(body.tenant.companyName).toBe('Fenzit Services');
      expect(body.skills).toEqual([]);
      expect(body.skillIds).toEqual([]);
      // The technician shape carries no roster or customer page at all.
      expect(body).not.toHaveProperty('technicians');
      expect(body).not.toHaveProperty('customers');
    });

    it('pre-onboarding person (no company yet) — 200 with the minimal profile', async () => {
      ownUserRow = { ...ownerRow, id: NEW_ID };

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${jwt('new')}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // No company yet, so no role either.
      expect(body.role).toBeNull();
      expect(body.tenant).toBeNull();
      expect(body.customerCount).toBe(0);
      expect(body.jobCounts).toEqual({
        today: 0,
        upcoming: 0,
        overdue: 0,
        completed: 0,
        cancelled: 0,
      });
      // Pre-onboarding: no tenant → the attendance-free default, still
      // present so the FE gate reads one stable field.
      expect(body.attendance).toEqual({
        attendanceEnabled: false,
        attendanceAccess: 'none',
        attendanceStartDate: null,
        onboardedAt: null,
        pendingLeaveRequests: 0,
      });
    });

    it('returns 401 without a JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 422 for an invalid jobsScope (the global validation pipe contract)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me?jobsScope=bogus',
        headers: { authorization: `Bearer ${jwt('owner')}` },
      });

      expect(response.statusCode).toBe(422);
    });
  });
});