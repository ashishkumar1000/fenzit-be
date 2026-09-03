import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CustomersService } from './customers.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { decodeCursor, encodeCursor } from '../common/utils/cursor.util';
import { CreateCustomerDto } from './dto/create-customer.dto';

describe('CustomersService', () => {
  let service: CustomersService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;

  const ownerUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const ownerNoTenant: RequestUser = {
    userId: 'owner-uuid',
    tenantId: null,
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const dto: CreateCustomerDto = {
    name: 'Priya Sharma',
    countryCode: '+91',
    phoneNumber: '9876543210',
    address: '12 MG Road',
    city: 'Bengaluru',
  };

  const dbRow = {
    id: 'customer-uuid',
    name: 'Priya Sharma',
    country_code: '+91',
    phone_number: '9876543210',
    address: '12 MG Road',
    city: 'Bengaluru',
    created_via: 'manual' as const,
    created_at: '2026-06-21T00:00:00Z',
    tenant_id: 'tenant-uuid',
  };

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  function mockInsert(result: { data: unknown; error: unknown }) {
    const single = jest.fn().mockResolvedValue(result);
    const select = jest.fn().mockReturnValue({ single });
    const insert = jest.fn().mockReturnValue({ select });
    const from = jest.fn().mockReturnValue({ insert });
    supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
    return { from, insert, select, single };
  }

  describe('createCustomer', () => {
    it('should return camelCase customer object on success', async () => {
      mockInsert({ data: dbRow, error: null });

      const result = await service.createCustomer(ownerUser, dto);

      expect(result).toEqual({
        id: 'customer-uuid',
        name: 'Priya Sharma',
        countryCode: '+91',
        phoneNumber: '9876543210',
        address: '12 MG Road',
        city: 'Bengaluru',
        createdVia: 'manual',
        createdAt: '2026-06-21T00:00:00Z',
        tenantId: 'tenant-uuid',
      });
    });

    it('should persist tenant_id and null-out optional fields when omitted', async () => {
      const { insert } = mockInsert({
        data: { ...dbRow, address: null, city: null },
        error: null,
      });

      await service.createCustomer(ownerUser, {
        name: 'Priya Sharma',
        countryCode: '+91',
        phoneNumber: '9876543210',
      });

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 'tenant-uuid',
          country_code: '+91',
          phone_number: '9876543210',
          address: null,
          city: null,
        }),
      );
    });

    it('should throw 409 on duplicate phone (23505)', async () => {
      mockInsert({
        data: null,
        error: { code: '23505', message: 'unique constraint' },
      });

      await expect(service.createCustomer(ownerUser, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw 400 (VALIDATION_ERROR) on unknown country code FK violation (23503)', async () => {
      mockInsert({
        data: null,
        error: { code: '23503', message: 'foreign key violation' },
      });

      await expect(service.createCustomer(ownerUser, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw 400 when owner has no tenantId', async () => {
      await expect(service.createCustomer(ownerNoTenant, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('should throw 500 on generic DB error (non-23505)', async () => {
      mockInsert({
        data: null,
        error: { code: '08006', message: 'connection failure' },
      });

      await expect(service.createCustomer(ownerUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('listCustomers', () => {
    function makeRow(id: string, createdAt: string) {
      return {
        id,
        name: `Cust ${id}`,
        country_code: '+91',
        phone_number: `98765432${id}`,
        address: '12 MG Road',
        city: 'Bengaluru',
        created_at: createdAt,
      };
    }

    // Chainable query-builder mock. select/eq/or/order return the builder;
    // limit() resolves to { data, error }. Captures .or() args for assertions.
    // A second builder (dispatched by table name) backs the getJobStats
    // lookup against the `jobs` table — defaults to an empty result so tests
    // that don't care about job stats don't need to pass one.
    function mockQuery(
      result: { data: unknown; error: unknown },
      jobsResult: { data: unknown; error: unknown } = { data: [], error: null },
    ) {
      const orArgs: string[] = [];
      const builder: Record<string, jest.Mock> = {};
      builder.select = jest.fn(() => builder);
      builder.eq = jest.fn(() => builder);
      builder.or = jest.fn((arg: string) => {
        orArgs.push(arg);
        return builder;
      });
      builder.order = jest.fn(() => builder);
      builder.limit = jest.fn().mockResolvedValue(result);

      const jobsEqArgs: unknown[][] = [];
      const jobsInArgs: unknown[][] = [];
      const jobsBuilder: Record<string, jest.Mock> = {};
      jobsBuilder.select = jest.fn(() => jobsBuilder);
      jobsBuilder.eq = jest.fn((...args: unknown[]) => {
        jobsEqArgs.push(args);
        return jobsBuilder;
      });
      jobsBuilder.in = jest.fn((...args: unknown[]) => {
        jobsInArgs.push(args);
        return Promise.resolve(jobsResult);
      });

      const from = jest.fn((table: string) =>
        table === 'jobs' ? jobsBuilder : builder,
      );
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
      return { from, builder, jobsBuilder, orArgs, jobsEqArgs, jobsInArgs };
    }

    it('should compute jobCount and lastJobDate from the jobs table', async () => {
      const { jobsEqArgs, jobsInArgs } = mockQuery(
        { data: [makeRow('1', '2026-06-21T00:00:02Z')], error: null },
        {
          data: [
            { customer_id: '1', scheduled_start: '2026-06-10T09:00:00Z' },
            { customer_id: '1', scheduled_start: '2026-06-15T09:00:00Z' },
          ],
          error: null,
        },
      );

      const result = await service.listCustomers(ownerUser, {});

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: '1',
        name: 'Cust 1',
        countryCode: '+91',
        phoneNumber: '987654321',
        address: '12 MG Road',
        city: 'Bengaluru',
        jobCount: 2,
        lastJobDate: '2026-06-15T09:00:00Z',
      });
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(jobsEqArgs).toEqual([['tenant_id', 'tenant-uuid']]);
      expect(jobsInArgs).toEqual([['customer_id', ['1']]]);
    });

    it('should default jobCount to 0 and lastJobDate to null when a customer has no jobs', async () => {
      mockQuery(
        { data: [makeRow('2', '2026-06-21T00:00:02Z')], error: null },
        { data: [], error: null },
      );

      const result = await service.listCustomers(ownerUser, {});

      expect(result.data[0]).toEqual({
        id: '2',
        name: 'Cust 2',
        countryCode: '+91',
        phoneNumber: '987654322',
        address: '12 MG Road',
        city: 'Bengaluru',
        jobCount: 0,
        lastJobDate: null,
      });
    });

    it('should surface a 500 when the job-stats lookup fails', async () => {
      mockQuery(
        { data: [makeRow('3', '2026-06-21T00:00:02Z')], error: null },
        { data: null, error: { code: '08006', message: 'down' } },
      );

      await expect(service.listCustomers(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should return empty page when no rows', async () => {
      mockQuery({ data: [], error: null });

      const result = await service.listCustomers(ownerUser, {});

      expect(result.data).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it('should set nextCursor when more than PAGE_SIZE rows are returned', async () => {
      // 51 rows → hasMore, page trimmed to 50, cursor from the 50th row
      const rows = Array.from({ length: 51 }, (_, i) =>
        makeRow(String(i), `2026-06-21T00:00:${String(i).padStart(2, '0')}Z`),
      );
      mockQuery({ data: rows, error: null });

      const result = await service.listCustomers(ownerUser, {});

      expect(result.data).toHaveLength(50);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).not.toBeNull();
    });

    it('should build an ilike .or() on name and phone for a search term', async () => {
      const { orArgs } = mockQuery({ data: [], error: null });

      await service.listCustomers(ownerUser, { q: 'priya' });

      expect(orArgs).toContain('name.ilike.*priya*,phone_number.ilike.*priya*');
    });

    it('should match on phone digits for a numeric search term (AC3)', async () => {
      const { orArgs } = mockQuery({ data: [], error: null });

      await service.listCustomers(ownerUser, { q: '9833' });

      expect(orArgs).toContain('name.ilike.*9833*,phone_number.ilike.*9833*');
    });

    it('should strip structural chars / escape LIKE metachars but preserve "." and ":"', async () => {
      const { orArgs } = mockQuery({ data: [], error: null });

      await service.listCustomers(ownerUser, { q: 'a,b)c%_d. e:f' });

      // `,` `)` stripped, `%`/`_` escaped, but `.` and `:` kept (safe in an ilike value)
      expect(orArgs[0]).toBe(
        'name.ilike.*abc\\%\\_d. e:f*,phone_number.ilike.*abc\\%\\_d. e:f*',
      );
    });

    const CURSOR_UUID = '00000000-0000-4000-8000-000000000001';

    it('should apply a keyset .or() when a cursor is supplied', async () => {
      const cursor = Buffer.from(
        JSON.stringify({
          id: CURSOR_UUID,
          createdAt: '2026-06-21T00:00:00Z',
          scope: 'customers-list',
        }),
      ).toString('base64url');
      const { orArgs } = mockQuery({ data: [], error: null });

      await service.listCustomers(ownerUser, { cursor });

      expect(orArgs).toContain(
        `created_at.lt.2026-06-21T00:00:00Z,and(created_at.eq.2026-06-21T00:00:00Z,id.lt.${CURSOR_UUID})`,
      );
    });

    it('AC5 — nextCursor round-trips to the last returned row across a created_at tie at the boundary', async () => {
      // 51 rows; rows 49 and 50 share a created_at so the boundary lands on a tie.
      const uuid = (n: number) =>
        `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const rows = Array.from({ length: 51 }, (_, i) => ({
        id: uuid(i),
        name: `Cust ${i}`,
        country_code: '+91',
        phone_number: `98765${String(i).padStart(5, '0')}`,
        city: 'Bengaluru',
        // distinct timestamps except rows 49 & 50 (indices 49,50) tie
        created_at:
          i >= 49
            ? '2026-06-21T00:00:00Z'
            : `2026-06-21T00:01:${String(i).padStart(2, '0')}Z`,
      }));
      mockQuery({ data: rows, error: null });

      const result = await service.listCustomers(ownerUser, {});

      expect(result.data).toHaveLength(50);
      expect(result.hasMore).toBe(true);
      // nextCursor must encode the 50th RETURNED row (index 49), not the 51st probe row
      const decoded = decodeCursor(result.nextCursor as string);
      expect(decoded.id).toBe(uuid(49));
      expect(decoded.createdAt).toBe('2026-06-21T00:00:00Z');
    });

    it('should throw 400 on a malformed (non-base64-JSON) cursor', async () => {
      mockQuery({ data: [], error: null });

      await expect(
        service.listCustomers(ownerUser, { cursor: 'not-a-valid-cursor' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw 400 on a forged cursor injecting PostgREST filter syntax', async () => {
      mockQuery({ data: [], error: null });
      const forged = Buffer.from(
        JSON.stringify({
          id: 'x),or(tenant_id.neq.0',
          createdAt: '2026-06-21T00:00:00Z',
        }),
      ).toString('base64url');

      await expect(
        service.listCustomers(ownerUser, { cursor: forged }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw 400 when owner has no tenantId', async () => {
      await expect(service.listCustomers(ownerNoTenant, {})).rejects.toThrow(
        BadRequestException,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('should throw 500 on a DB error', async () => {
      mockQuery({ data: null, error: { code: '08006', message: 'down' } });

      await expect(service.listCustomers(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getCustomerDetail', () => {
    const CUSTOMER_ID = '00000000-0000-4000-8000-000000000001';

    const jobRow = (n: number) => ({
      id: `00000000-0000-4000-8000-00000000010${n}`,
      job_number: `JOB-${n}`,
      scheduled_start: `2026-0${n}-01T00:00:00Z`,
      status: 'completed',
      service_type: 'ac_service',
    });

    // Customer fetch terminal is .single() after two .eq() calls (id, tenant_id).
    // Job-history fetch terminal is .limit() after .select/.eq/.eq(/.or)/.order/.order.
    // Routed by table name since getCustomerDetail now queries both. eq/order
    // args are captured so the tenant/customer scoping and sort order are asserted,
    // not just the terminal result.
    function mockDetail(
      customerResult: { data: unknown; error: unknown },
      jobHistoryResult: { data: unknown; error: unknown } = {
        data: [],
        error: null,
      },
    ) {
      const single = jest.fn().mockResolvedValue(customerResult);
      const eqTenant = jest.fn().mockReturnValue({ single });
      const eqId = jest.fn().mockReturnValue({ eq: eqTenant });
      const customerSelect = jest.fn().mockReturnValue({ eq: eqId });

      const orArgs: string[] = [];
      const eqArgs: [string, unknown][] = [];
      const orderArgs: [string, { ascending: boolean }][] = [];
      const jobsBuilder: Record<string, jest.Mock> = {};
      jobsBuilder.select = jest.fn(() => jobsBuilder);
      jobsBuilder.eq = jest.fn((...args: [string, unknown]) => {
        eqArgs.push(args);
        return jobsBuilder;
      });
      jobsBuilder.or = jest.fn((arg: string) => {
        orArgs.push(arg);
        return jobsBuilder;
      });
      jobsBuilder.order = jest.fn(
        (...args: [string, { ascending: boolean }]) => {
          orderArgs.push(args);
          return jobsBuilder;
        },
      );
      jobsBuilder.limit = jest.fn().mockResolvedValue(jobHistoryResult);

      const from = jest.fn((table: string) =>
        table === 'jobs' ? jobsBuilder : { select: customerSelect },
      );
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
      return { from, single, jobsBuilder, orArgs, eqArgs, orderArgs };
    }

    it('should return the full profile plus an empty jobHistory envelope', async () => {
      mockDetail({ data: dbRow, error: null });

      const result = await service.getCustomerDetail(ownerUser, CUSTOMER_ID);

      expect(result.id).toBe('customer-uuid');
      expect(result.name).toBe('Priya Sharma');
      expect(result.countryCode).toBe('+91');
      expect(result.phoneNumber).toBe('9876543210');
      expect(result.address).toBe('12 MG Road');
      expect(result.city).toBe('Bengaluru');
      expect(result.createdVia).toBe('manual');
      expect(result.tenantId).toBe('tenant-uuid');
      expect(result.jobHistory).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
    });

    it('should return the first page of job history sorted scheduled_start DESC', async () => {
      const row2 = jobRow(2);
      const row1 = jobRow(1);
      mockDetail(
        { data: dbRow, error: null },
        { data: [row2, row1], error: null },
      );

      const result = await service.getCustomerDetail(ownerUser, CUSTOMER_ID);

      expect(result.jobHistory.hasMore).toBe(false);
      expect(result.jobHistory.nextCursor).toBeNull();
      expect(result.jobHistory.data).toEqual([
        {
          id: row2.id,
          jobNumber: row2.job_number,
          scheduledStart: row2.scheduled_start,
          status: row2.status,
          serviceType: row2.service_type,
        },
        {
          id: row1.id,
          jobNumber: row1.job_number,
          scheduledStart: row1.scheduled_start,
          status: row1.status,
          serviceType: row1.service_type,
        },
      ]);
    });

    it('should scope the job-history query to the tenant and customer, sorted scheduled_start/id DESC', async () => {
      // createAdmin() bypasses RLS, so the .eq('tenant_id')/.eq('customer_id')
      // filters are the ONLY isolation — this pins them (and the sort).
      const { eqArgs, orderArgs } = mockDetail(
        { data: dbRow, error: null },
        { data: [], error: null },
      );

      await service.getCustomerDetail(ownerUser, CUSTOMER_ID);

      expect(eqArgs).toContainEqual(['tenant_id', 'tenant-uuid']);
      expect(eqArgs).toContainEqual(['customer_id', CUSTOMER_ID]);
      expect(orderArgs).toEqual([
        ['scheduled_start', { ascending: false }],
        ['id', { ascending: false }],
      ]);
    });

    it('should return a nextCursor and hasMore=true when more than 20 jobs exist', async () => {
      // rows arrive from the DB newest-first (scheduled_start DESC)
      const rows = Array.from({ length: 21 }, (_, i) => ({
        id: `00000000-0000-4000-8000-0000000010${String(i).padStart(2, '0')}`,
        job_number: `JOB-${i}`,
        scheduled_start: `2026-01-${(21 - i).toString().padStart(2, '0')}T00:00:00Z`,
        status: 'completed',
        service_type: 'ac_service',
      }));
      const { jobsBuilder } = mockDetail(
        { data: dbRow, error: null },
        { data: rows, error: null },
      );

      const result = await service.getCustomerDetail(ownerUser, CUSTOMER_ID);

      expect(result.jobHistory.data).toHaveLength(20);
      expect(result.jobHistory.hasMore).toBe(true);
      expect(result.jobHistory.nextCursor).not.toBeNull();
      expect(jobsBuilder.limit).toHaveBeenCalledWith(21);
      expect(jobsBuilder.order).toHaveBeenCalledWith('scheduled_start', {
        ascending: false,
      });
      expect(jobsBuilder.order).toHaveBeenCalledWith('id', { ascending: false });

      // nextCursor must encode the 20th RETURNED row (index 19), not the 21st probe row
      const decoded = decodeCursor(result.jobHistory.nextCursor as string);
      expect(decoded.id).toBe(rows[19].id);
      expect(decoded.createdAt).toBe(rows[19].scheduled_start);
      expect(decoded.scope).toBe('customer-history');
    });

    it('should return hasMore=false and no nextCursor at exactly 20 jobs (boundary)', async () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({
        id: `00000000-0000-4000-8000-0000000020${String(i).padStart(2, '0')}`,
        job_number: `JOB-${i}`,
        scheduled_start: `2026-01-${(20 - i).toString().padStart(2, '0')}T00:00:00Z`,
        status: 'completed',
        service_type: 'ac_service',
      }));
      const { jobsBuilder } = mockDetail(
        { data: dbRow, error: null },
        { data: rows, error: null },
      );

      const result = await service.getCustomerDetail(ownerUser, CUSTOMER_ID);

      expect(result.jobHistory.data).toHaveLength(20);
      expect(result.jobHistory.hasMore).toBe(false);
      expect(result.jobHistory.nextCursor).toBeNull();
      expect(jobsBuilder.limit).toHaveBeenCalledWith(21);
    });

    it('should return the second page when a valid nextCursor is passed back (round-trip)', async () => {
      // page 1: 21 rows → 20 returned + probe row
      const rows = Array.from({ length: 21 }, (_, i) => ({
        id: `00000000-0000-4000-8000-0000000030${String(i).padStart(2, '0')}`,
        job_number: `JOB-${i}`,
        scheduled_start: `2026-01-${(21 - i).toString().padStart(2, '0')}T00:00:00Z`,
        status: 'completed',
        service_type: 'ac_service',
      }));
      mockDetail({ data: dbRow, error: null }, { data: rows, error: null });

      const page1 = await service.getCustomerDetail(ownerUser, CUSTOMER_ID);
      expect(page1.jobHistory.nextCursor).not.toBeNull();

      // page 2: only the probe row (index 20) is left past the cursor
      mockDetail({ data: dbRow, error: null }, { data: [rows[20]], error: null });

      const page2 = await service.getCustomerDetail(
        ownerUser,
        CUSTOMER_ID,
        page1.jobHistory.nextCursor as string,
      );

      expect(page2.jobHistory.data).toEqual([
        {
          id: rows[20].id,
          jobNumber: rows[20].job_number,
          scheduledStart: rows[20].scheduled_start,
          status: rows[20].status,
          serviceType: rows[20].service_type,
        },
      ]);
      expect(page2.jobHistory.hasMore).toBe(false);
      expect(page2.jobHistory.nextCursor).toBeNull();
    });

    it('should apply the scheduled_start keyset predicate for a job-history cursor', async () => {
      const cursorId = '00000000-0000-4000-8000-000000009999';
      const cursor = Buffer.from(
        JSON.stringify({
          id: cursorId,
          createdAt: '2026-02-01T00:00:00Z',
          scope: 'customer-history',
        }),
      ).toString('base64url');
      const { orArgs } = mockDetail(
        { data: dbRow, error: null },
        { data: [jobRow(1)], error: null },
      );

      await service.getCustomerDetail(ownerUser, CUSTOMER_ID, cursor);

      expect(orArgs).toContain(
        `scheduled_start.lt.2026-02-01T00:00:00Z,and(scheduled_start.eq.2026-02-01T00:00:00Z,id.lt.${cursorId})`,
      );
    });

    it('should throw 400 for a cursor minted for a different endpoint (scope mismatch)', async () => {
      // e.g. the jobs-list cursor (keyed on created_at) replayed here — before
      // scope checks it decoded cleanly and silently filtered scheduled_start
      const jobsListCursor = encodeCursor(
        '00000000-0000-4000-8000-000000009999',
        '2026-06-21T00:00:00Z',
        'jobs-list',
      );
      mockDetail({ data: dbRow, error: null });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID, jobsListCursor),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return the first page (no .or() predicate) for an empty-string cursor', async () => {
      // `?cursor=` must behave like no cursor — not a 400
      const { orArgs } = mockDetail(
        { data: dbRow, error: null },
        { data: [jobRow(1)], error: null },
      );

      const result = await service.getCustomerDetail(
        ownerUser,
        CUSTOMER_ID,
        '',
      );

      expect(orArgs).toHaveLength(0);
      expect(result.jobHistory.data).toHaveLength(1);
    });

    it('should throw 400 for a malformed job-history cursor', async () => {
      mockDetail({ data: dbRow, error: null });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID, 'not-a-valid-cursor'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw 404 before 400 — missing customer + malformed cursor', async () => {
      // ordering invariant: the customer lookup runs before the cursor decodes,
      // so a bad cursor on a missing/cross-tenant customer yields 404, not 400
      mockDetail({ data: null, error: { code: 'PGRST116' } });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID, 'not-a-valid-cursor'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 500 when the job-history query fails', async () => {
      mockDetail(
        { data: dbRow, error: null },
        { data: null, error: { code: '08006', message: 'down' } },
      );

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw 404 when the customer does not exist (PGRST116)', async () => {
      mockDetail({ data: null, error: { code: 'PGRST116' } });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 404 when the row belongs to another tenant (empty result)', async () => {
      // tenant_id filter returns no rows → PGRST116, same as not-found
      mockDetail({ data: null, error: { code: 'PGRST116' } });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 404 when single() returns no data and no error', async () => {
      // guards the (error: null, data: null) cell — must not 500, must 404
      mockDetail({ data: null, error: null });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 404 (defense-in-depth) if a returned row is from another tenant', async () => {
      // simulates a future dropped tenant filter: row present but wrong tenant
      mockDetail({
        data: { ...dbRow, tenant_id: 'other-tenant' },
        error: null,
      });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 500 on a non-PGRST116 DB error', async () => {
      mockDetail({ data: null, error: { code: '08006', message: 'down' } });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw 400 when owner has no tenantId', async () => {
      await expect(
        service.getCustomerDetail(ownerNoTenant, CUSTOMER_ID),
      ).rejects.toThrow(BadRequestException);
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });
  });

  describe('findOrCreateByPhone', () => {
    const input = {
      name: 'Priya Sharma',
      countryCode: '+91',
      phoneNumber: '9876543210',
    };

    // Lookup chain: from().select().eq().eq().eq().maybeSingle()
    // Insert chain: from().insert().select().single()
    // Both go through the same from() return object.
    function mockFindOrCreate(
      lookup: { data: unknown; error: unknown },
      insertResult?: { data: unknown; error: unknown },
    ) {
      const maybeSingle = jest.fn().mockResolvedValue(lookup);
      const eq3 = jest.fn().mockReturnValue({ maybeSingle });
      const eq2 = jest.fn().mockReturnValue({ eq: eq3 });
      const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
      const selectLookup = jest.fn().mockReturnValue({ eq: eq1 });

      const single = jest
        .fn()
        .mockResolvedValue(insertResult ?? { data: null, error: null });
      const selectInsert = jest.fn().mockReturnValue({ single });
      const insert = jest.fn().mockReturnValue({ select: selectInsert });

      const from = jest.fn().mockReturnValue({ select: selectLookup, insert });
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
      return { from, insert, maybeSingle, single };
    }

    it('should return the existing customer (link) without inserting', async () => {
      const { insert } = mockFindOrCreate({ data: dbRow, error: null });

      const result = await service.findOrCreateByPhone(ownerUser, input);

      expect(result.id).toBe('customer-uuid');
      expect(result.createdVia).toBe('manual');
      expect(insert).not.toHaveBeenCalled();
    });

    it("should create a new customer with created_via 'job_creation' when none exists", async () => {
      const created = { ...dbRow, created_via: 'job_creation' as const };
      const { insert } = mockFindOrCreate(
        { data: null, error: null },
        { data: created, error: null },
      );

      const result = await service.findOrCreateByPhone(ownerUser, input);

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 'tenant-uuid',
          country_code: '+91',
          phone_number: '9876543210',
          created_via: 'job_creation',
        }),
      );
      expect(result.createdVia).toBe('job_creation');
    });

    it('should throw 400 (VALIDATION_ERROR) on unknown country code (23503)', async () => {
      mockFindOrCreate(
        { data: null, error: null },
        { data: null, error: { code: '23503', message: 'fk' } },
      );

      await expect(
        service.findOrCreateByPhone(ownerUser, input),
      ).rejects.toThrow(BadRequestException);
    });

    it('should re-read the winning row on a concurrent insert race (23505)', async () => {
      // First lookup misses; insert loses the race (23505); recursion lookup hits.
      const maybeSingle = jest
        .fn()
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: dbRow, error: null });
      const eq3 = jest.fn().mockReturnValue({ maybeSingle });
      const eq2 = jest.fn().mockReturnValue({ eq: eq3 });
      const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
      const selectLookup = jest.fn().mockReturnValue({ eq: eq1 });
      const single = jest
        .fn()
        .mockResolvedValueOnce({ data: null, error: { code: '23505' } });
      const selectInsert = jest.fn().mockReturnValue({ single });
      const insert = jest.fn().mockReturnValue({ select: selectInsert });
      const from = jest.fn().mockReturnValue({ select: selectLookup, insert });
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);

      const result = await service.findOrCreateByPhone(ownerUser, input);

      expect(result.id).toBe('customer-uuid');
      expect(maybeSingle).toHaveBeenCalledTimes(2);
    });

    it('should throw 500 (not recurse forever) when 23505 persists after the retry', async () => {
      // Lookup always misses; insert always loses the race → bounded to one retry,
      // then 500 instead of unbounded recursion.
      const maybeSingle = jest
        .fn()
        .mockResolvedValue({ data: null, error: null });
      const eq3 = jest.fn().mockReturnValue({ maybeSingle });
      const eq2 = jest.fn().mockReturnValue({ eq: eq3 });
      const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
      const selectLookup = jest.fn().mockReturnValue({ eq: eq1 });
      const single = jest
        .fn()
        .mockResolvedValue({ data: null, error: { code: '23505' } });
      const selectInsert = jest.fn().mockReturnValue({ single });
      const insert = jest.fn().mockReturnValue({ select: selectInsert });
      const from = jest.fn().mockReturnValue({ select: selectLookup, insert });
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);

      await expect(
        service.findOrCreateByPhone(ownerUser, input),
      ).rejects.toThrow(InternalServerErrorException);
      // initial attempt + exactly one retry
      expect(insert).toHaveBeenCalledTimes(2);
    });

    it('should throw 500 on a lookup DB error', async () => {
      mockFindOrCreate({ data: null, error: { code: '08006' } });

      await expect(
        service.findOrCreateByPhone(ownerUser, input),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw 400 when owner has no tenantId', async () => {
      await expect(
        service.findOrCreateByPhone(ownerNoTenant, input),
      ).rejects.toThrow(BadRequestException);
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });
  });
});
