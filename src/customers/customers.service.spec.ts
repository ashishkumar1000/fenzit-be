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
import { decodeCursor } from '../common/utils/cursor.util';
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
        city: 'Bengaluru',
        created_at: createdAt,
      };
    }

    // Chainable query-builder mock. select/eq/or/order return the builder;
    // limit() resolves to { data, error }. Captures .or() args for assertions.
    function mockQuery(result: { data: unknown; error: unknown }) {
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
      const from = jest.fn(() => builder);
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
      return { from, builder, orArgs };
    }

    it('should map rows to list items with jobCount 0 / lastJobDate null', async () => {
      mockQuery({
        data: [makeRow('1', '2026-06-21T00:00:02Z')],
        error: null,
      });

      const result = await service.listCustomers(ownerUser, {});

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: '1',
        name: 'Cust 1',
        countryCode: '+91',
        phoneNumber: '987654321',
        city: 'Bengaluru',
        jobCount: 0,
        lastJobDate: null,
      });
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
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
        JSON.stringify({ id: CURSOR_UUID, createdAt: '2026-06-21T00:00:00Z' }),
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

    // detail query terminal is .single() after two .eq() calls (id, tenant_id)
    function mockSingle(result: { data: unknown; error: unknown }) {
      const single = jest.fn().mockResolvedValue(result);
      const eqTenant = jest.fn().mockReturnValue({ single });
      const eqId = jest.fn().mockReturnValue({ eq: eqTenant });
      const select = jest.fn().mockReturnValue({ eq: eqId });
      const from = jest.fn().mockReturnValue({ select });
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
      return { from, select, eqId, eqTenant, single };
    }

    it('should return the full profile plus an empty jobHistory envelope', async () => {
      mockSingle({ data: dbRow, error: null });

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

    it('should throw 404 when the customer does not exist (PGRST116)', async () => {
      mockSingle({ data: null, error: { code: 'PGRST116' } });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 404 when the row belongs to another tenant (empty result)', async () => {
      // tenant_id filter returns no rows → PGRST116, same as not-found
      mockSingle({ data: null, error: { code: 'PGRST116' } });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 404 when single() returns no data and no error', async () => {
      // guards the (error: null, data: null) cell — must not 500, must 404
      mockSingle({ data: null, error: null });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 404 (defense-in-depth) if a returned row is from another tenant', async () => {
      // simulates a future dropped tenant filter: row present but wrong tenant
      mockSingle({
        data: { ...dbRow, tenant_id: 'other-tenant' },
        error: null,
      });

      await expect(
        service.getCustomerDetail(ownerUser, CUSTOMER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 500 on a non-PGRST116 DB error', async () => {
      mockSingle({ data: null, error: { code: '08006', message: 'down' } });

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
