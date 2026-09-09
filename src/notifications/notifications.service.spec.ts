import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { encodeCursor } from '../common/utils/cursor.util';

/**
 * Chainable query-builder mock mirroring the Supabase builder surface this
 * service touches. Every method returns the same object, which is itself
 * thenable — so `await` on any chain tail resolves with `result`.
 */
function mockQueryBuilder(result: {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}) {
  const qb = {} as Record<string, jest.Mock> & {
    then: jest.Mock;
  };
  for (const m of [
    'select',
    'eq',
    'or',
    'is',
    'in',
    'order',
    'limit',
    'update',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.then = jest.fn((resolve: (v: unknown) => unknown) =>
    resolve({ data: result.data, error: result.error, count: result.count }),
  );
  return qb;
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;

  const ownerUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const noTenantUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: null,
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const dbRow = {
    id: 'n-1',
    job_id: 'job-uuid',
    event_type: 'on_my_way',
    payload: {
      job_number: 'JOB-1',
      step: 'on_my_way',
      technician_name: 'Ravi',
    },
    read_at: null,
    created_at: '2026-09-09T10:00:00Z',
  };

  function mockFrom(qb: ReturnType<typeof mockQueryBuilder>) {
    const from = jest.fn().mockReturnValue(qb);
    supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
    return { from, qb };
  }

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  describe('listNotifications', () => {
    it('should return camelCase rows in the shared PaginatedResponse envelope', async () => {
      const { qb } = mockFrom(mockQueryBuilder({ data: [dbRow], error: null }));

      const result = await service.listNotifications(ownerUser, {});

      expect(result).toEqual({
        data: [
          {
            id: 'n-1',
            jobId: 'job-uuid',
            eventType: 'on_my_way',
            payload: dbRow.payload,
            readAt: null,
            createdAt: '2026-09-09T10:00:00Z',
          },
        ],
        nextCursor: null,
        hasMore: false,
      });
      expect(qb['order']).toHaveBeenCalledWith('created_at', {
        ascending: false,
      });
      expect(qb['order']).toHaveBeenCalledWith('id', { ascending: false });
    });

    it('should default the page size to 20 (limit 21 fetches one extra row for hasMore)', async () => {
      const { qb } = mockFrom(mockQueryBuilder({ data: [], error: null }));

      await service.listNotifications(ownerUser, {});

      expect(qb['limit']).toHaveBeenCalledWith(21);
    });

    it('should respect an explicit limit (limit + 1 for the peek row)', async () => {
      const { qb } = mockFrom(mockQueryBuilder({ data: [], error: null }));

      await service.listNotifications(ownerUser, { limit: 30 });

      expect(qb['limit']).toHaveBeenCalledWith(31);
    });

    it('should respect the limit boundaries (1 and 50, + 1 for the peek row)', async () => {
      const first = mockFrom(mockQueryBuilder({ data: [], error: null }));
      await service.listNotifications(ownerUser, { limit: 1 });
      expect(first.qb['limit']).toHaveBeenCalledWith(2);

      const last = mockFrom(mockQueryBuilder({ data: [], error: null }));
      await service.listNotifications(ownerUser, { limit: 50 });
      expect(last.qb['limit']).toHaveBeenCalledWith(51);
    });

    it('should slice the peek row and mint nextCursor from the last row when a full page comes back', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({
        ...dbRow,
        id: `n-${i}`,
        created_at: `2026-09-09T10:00:${String(21 - i).padStart(2, '0')}Z`,
      }));
      mockFrom(mockQueryBuilder({ data: rows, error: null }));

      const result = await service.listNotifications(ownerUser, {});

      expect(result.data).toHaveLength(20);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe(
        encodeCursor('n-19', '2026-09-09T10:00:02Z', 'notifications-list'),
      );
    });

    it('should apply the keyset or-filter when a cursor is provided', async () => {
      const { qb } = mockFrom(mockQueryBuilder({ data: [], error: null }));
      const cursor = encodeCursor(
        '00000000-0000-4000-8000-000000000019',
        '2026-09-09T10:00:02Z',
        'notifications-list',
      );

      await service.listNotifications(ownerUser, { cursor });

      expect(qb['or']).toHaveBeenCalledWith(
        'created_at.lt.2026-09-09T10:00:02Z,and(created_at.eq.2026-09-09T10:00:02Z,id.lt.00000000-0000-4000-8000-000000000019)',
      );
    });

    it('should reject a foreign-scope cursor with 400', async () => {
      mockFrom(mockQueryBuilder({ data: [], error: null }));
      const cursor = encodeCursor('x', '2026-09-09T10:00:02Z', 'jobs-list');

      await expect(
        service.listNotifications(ownerUser, { cursor }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should double-scope the query by tenant_id AND user_id', async () => {
      const { qb } = mockFrom(mockQueryBuilder({ data: [], error: null }));

      await service.listNotifications(ownerUser, {});

      expect(qb['eq']).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
      expect(qb['eq']).toHaveBeenCalledWith('user_id', 'owner-uuid');
    });

    it('should short-circuit to an empty page without any DB call when tenantId is null', async () => {
      const { from } = mockFrom(mockQueryBuilder({ data: [], error: null }));

      const result = await service.listNotifications(noTenantUser, {});

      expect(result).toEqual({ data: [], nextCursor: null, hasMore: false });
      expect(from).not.toHaveBeenCalled();
    });

    it('should map a DB error to 500 INTERNAL_SERVER_ERROR', async () => {
      mockFrom(mockQueryBuilder({ data: null, error: { message: 'boom' } }));

      await expect(service.listNotifications(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getUnreadCount', () => {
    it('should count read_at IS NULL rows for the recipient only', async () => {
      const { qb } = mockFrom(
        mockQueryBuilder({ data: null, error: null, count: 3 }),
      );

      const result = await service.getUnreadCount(ownerUser);

      expect(result).toEqual({ unreadCount: 3 });
      expect(qb['select']).toHaveBeenCalledWith('id', {
        count: 'exact',
        head: true,
      });
      expect(qb['is']).toHaveBeenCalledWith('read_at', null);
      expect(qb['eq']).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
      expect(qb['eq']).toHaveBeenCalledWith('user_id', 'owner-uuid');
    });

    it('should short-circuit to 0 without any DB call when tenantId is null', async () => {
      const { from } = mockFrom(mockQueryBuilder({ count: 0 }));

      const result = await service.getUnreadCount(noTenantUser);

      expect(result).toEqual({ unreadCount: 0 });
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('markRead', () => {
    it('should update only own unread rows in the given id set and report the marked count', async () => {
      const { qb } = mockFrom(
        mockQueryBuilder({ data: [{ id: 'n-1' }], error: null }),
      );

      const result = await service.markRead(ownerUser, {
        ids: ['n-1', 'foreign-id'],
      });

      expect(result).toEqual({ markedCount: 1 });
      const expectedUpdate: Record<string, unknown> = {
        read_at: expect.any(String),
      };
      expect(qb['update']).toHaveBeenCalledWith(
        expect.objectContaining(expectedUpdate),
      );
      expect(qb['in']).toHaveBeenCalledWith('id', ['n-1', 'foreign-id']);
      expect(qb['eq']).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
      expect(qb['eq']).toHaveBeenCalledWith('user_id', 'owner-uuid');
      expect(qb['is']).toHaveBeenCalledWith('read_at', null);
    });

    it('should short-circuit to 0 without any DB call when tenantId is null', async () => {
      const { from } = mockFrom({ data: [], error: null });

      const result = await service.markRead(noTenantUser, { ids: ['n-1'] });

      expect(result).toEqual({ markedCount: 0 });
      expect(from).not.toHaveBeenCalled();
    });

    it('should short-circuit to 0 without any DB call for an empty id list', async () => {
      const { from } = mockFrom({ data: [], error: null });

      const result = await service.markRead(ownerUser, { ids: [] });

      expect(result).toEqual({ markedCount: 0 });
      expect(from).not.toHaveBeenCalled();
    });

    it('should map a DB error to 500 INTERNAL_SERVER_ERROR', async () => {
      mockFrom(mockQueryBuilder({ data: null, error: { message: 'boom' } }));

      await expect(
        service.markRead(ownerUser, { ids: ['n-1'] }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('markAllRead', () => {
    it('should update every own unread row without an id filter', async () => {
      const { qb } = mockFrom(
        mockQueryBuilder({ data: [{ id: 'n-1' }, { id: 'n-2' }], error: null }),
      );

      const result = await service.markAllRead(ownerUser);

      expect(result).toEqual({ markedCount: 2 });
      expect(qb['in']).not.toHaveBeenCalled();
      expect(qb['eq']).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
      expect(qb['eq']).toHaveBeenCalledWith('user_id', 'owner-uuid');
      expect(qb['is']).toHaveBeenCalledWith('read_at', null);
    });

    it('should map a DB error to 500 INTERNAL_SERVER_ERROR', async () => {
      mockFrom(mockQueryBuilder({ data: null, error: { message: 'boom' } }));

      await expect(service.markAllRead(ownerUser)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should short-circuit to 0 without any DB call when tenantId is null', async () => {
      const { from } = mockFrom({ data: [], error: null });

      const result = await service.markAllRead(noTenantUser);

      expect(result).toEqual({ markedCount: 0 });
      expect(from).not.toHaveBeenCalled();
    });
  });
});
