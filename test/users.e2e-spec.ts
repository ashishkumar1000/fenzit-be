/**
 * Users (e2e) — route-level coverage for `GET /api/v1/users/me`.
 *
 * The service branch logic is fully unit-covered (`users.service.spec.ts`);
 * this spec pins what those tests cannot see: the Fastify route registration,
 * JWT auth, the roles guard, the global validation pipe (the 422 contract),
 * and the owner/technician profile contracts over the wire — including the
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

describe('Users (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;

  const TENANT_ID = 'tenant-uuid-users-e2e';
  const OWNER_ID = 'owner-uuid-users-e2e';

  const ownerRow = {
    id: OWNER_ID,
    name: 'Kumar Selvan',
    country_code: '+91',
    phone_number: '9000000000',
    role: 'owner',
    status: 'active',
    tenant_id: TENANT_ID,
  };

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

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({ create: jest.fn(), createAdmin: jest.fn(() => ({ from: mockFrom })) })
      .compile();

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

  function jwt(role: 'owner' | 'technician', tenantId: string | null) {
    return jwtService.sign({
      sub: role === 'owner' ? OWNER_ID : 'tech-uuid-users-e2e',
      tenantId,
      role,
    });
  }

  describe('GET /api/v1/users/me', () => {
    it('owner — 200 with the full profile contract, customerCount included', async () => {
      ownUserRow = ownerRow;

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${jwt('owner', TENANT_ID)}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.role).toBe('owner');
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
    });

    it('technician — 200 with the role-specific shape (skills, no customers)', async () => {
      ownUserRow = { ...ownerRow, id: 'tech-uuid-users-e2e', role: 'technician' };

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${jwt('technician', TENANT_ID)}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.role).toBe('technician');
      expect(body.tenant.companyName).toBe('Fenzit Services');
      expect(body.skills).toEqual([]);
      expect(body.skillIds).toEqual([]);
      // The technician shape carries no roster or customer page at all.
      expect(body).not.toHaveProperty('technicians');
      expect(body).not.toHaveProperty('customers');
    });

    it('pre-onboarding owner (no tenant yet) — 200 with the minimal profile', async () => {
      ownUserRow = { ...ownerRow, tenant_id: null };

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${jwt('owner', null)}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.role).toBe('owner');
      expect(body.tenant).toBeNull();
      expect(body.customerCount).toBe(0);
      expect(body.jobCounts).toEqual({
        today: 0,
        upcoming: 0,
        overdue: 0,
        completed: 0,
        cancelled: 0,
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
        headers: { authorization: `Bearer ${jwt('owner', TENANT_ID)}` },
      });

      expect(response.statusCode).toBe(422);
    });
  });
});