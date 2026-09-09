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

describe('Notifications (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;

  const TENANT_ID = 'tenant-uuid-notifications-e2e';
  const OWNER_ID = '00000000-0000-4000-8000-000000000001';
  const TECH_ID = '00000000-0000-4000-8000-000000000002';
  const NOTIF_A = '00000000-0000-4000-8000-0000000000a1';
  const NOTIF_B = '00000000-0000-4000-8000-0000000000a2';

  beforeAll(async () => {
    mockCreateAdmin = jest.fn();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({ create: jest.fn(), createAdmin: mockCreateAdmin })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    app.setGlobalPrefix('api/v1', {
      exclude: ['health', 'internal/webhooks/storage'],
    });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  function ownerJwt(tenantId: string | null = TENANT_ID) {
    return jwtService.sign({ sub: OWNER_ID, tenantId, role: 'owner' });
  }

  function techJwt() {
    return jwtService.sign({
      sub: TECH_ID,
      tenantId: TENANT_ID,
      role: 'technician',
    });
  }

  const unreadRow = {
    id: NOTIF_A,
    job_id: '00000000-0000-4000-8000-0000000000b1',
    event_type: 'on_my_way',
    payload: {
      job_number: 'JB-2026-0001',
      step: 'on_my_way',
      technician_name: 'Ravi',
    },
    read_at: null,
    created_at: '2026-09-09T10:00:00Z',
  };

  const readRow = {
    ...unreadRow,
    id: NOTIF_B,
    read_at: '2026-09-09T11:00:00Z',
  };

  // The notifications service awaits its builder at a different terminal per
  // operation (limit / is / select-after-update), so every method returns the
  // builder and the builder itself is thenable — awaiting any chain resolves
  // with `result`. Args are captured for double-scoping assertions.
  function mockNotificationsBuilder(result: {
    data?: unknown;
    error?: unknown;
    count?: number | null;
  }) {
    const captured: {
      eq: Array<[string, unknown]>;
      or: string[];
      in: unknown[];
      update: unknown[];
      is: unknown[];
      order: unknown[];
      select: unknown[];
      limit: unknown[];
    } = {
      eq: [],
      or: [],
      in: [],
      update: [],
      is: [],
      order: [],
      select: [],
      limit: [],
    };
    const builder: Record<string, jest.Mock> = {
      select: jest.fn((...args: unknown[]) => {
        captured.select.push(args);
        return builder;
      }),
      eq: jest.fn((...args: unknown[]) => {
        captured.eq.push(args);
        return builder;
      }),
      or: jest.fn((...args: unknown[]) => {
        captured.or.push(args);
        return builder;
      }),
      is: jest.fn((...args: unknown[]) => {
        captured.is.push(args);
        return builder;
      }),
      in: jest.fn((...args: unknown[]) => {
        captured.in.push(args);
        return builder;
      }),
      order: jest.fn((...args: unknown[]) => {
        captured.order.push(args);
        return builder;
      }),
      limit: jest.fn((...args: unknown[]) => {
        captured.limit.push(args);
        return builder;
      }),
      update: jest.fn((...args: unknown[]) => {
        captured.update.push(args);
        return builder;
      }),
    } as any;
    builder.then = jest.fn((resolve: (v: unknown) => unknown) =>
      resolve({ data: result.data, error: result.error, count: result.count }),
    );

    mockCreateAdmin.mockReturnValue({ from: jest.fn(() => builder) });
    return { builder, captured };
  }

  describe('GET /api/v1/notifications', () => {
    it("should return 200 with the caller's rows, newest first, in the shared envelope", async () => {
      const { captured } = mockNotificationsBuilder({
        data: [unreadRow, readRow],
        error: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();
      expect(body.data).toHaveLength(2);
      // camelCase boundary shape; payload verbatim; readAt preserved
      expect(body.data[0]).toEqual({
        id: NOTIF_A,
        jobId: '00000000-0000-4000-8000-0000000000b1',
        eventType: 'on_my_way',
        payload: unreadRow.payload,
        readAt: null,
        createdAt: '2026-09-09T10:00:00Z',
      });
      expect(body.data[1].readAt).toBe('2026-09-09T11:00:00Z');
      // newest first: created_at DESC, id DESC
      expect(captured.order[0]).toEqual(['created_at', { ascending: false }]);
      expect(captured.order[1]).toEqual(['id', { ascending: false }]);
    });

    it('should double-scope the query by tenant_id AND user_id', async () => {
      const { captured } = mockNotificationsBuilder({
        data: [],
        error: null,
      });

      await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(captured.eq).toContainEqual(['tenant_id', TENANT_ID]);
      expect(captured.eq).toContainEqual(['user_id', OWNER_ID]);
    });

    it('should default the page size to 20 (limit 21 for the peek row)', async () => {
      const { captured } = mockNotificationsBuilder({ data: [], error: null });

      await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(captured.limit[0]).toEqual([21]);
    });

    it('should mint a nextCursor on a full page and apply the keyset filter when it is passed back', async () => {
      // 21 rows for limit 20 → hasMore. Distinct ids so the minted cursor is
      // deterministic (last page row wins).
      const rows = Array.from({ length: 21 }, (_, i) => ({
        ...unreadRow,
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      }));
      mockNotificationsBuilder({ data: rows, error: null });

      const page1 = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications?limit=20',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(page1.statusCode).toBe(200);
      const body1 = JSON.parse(page1.body);
      expect(body1.data).toHaveLength(20);
      expect(body1.hasMore).toBe(true);
      expect(body1.nextCursor).not.toBeNull();

      // Pass the cursor back — the second page filters strictly-older rows.
      const { captured: captured2 } = mockNotificationsBuilder({
        data: [],
        error: null,
      });
      const page2 = await app.inject({
        method: 'GET',
        url: `/api/v1/notifications?cursor=${body1.nextCursor}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(page2.statusCode).toBe(200);
      expect(JSON.parse(page2.body).nextCursor).toBeNull();
      expect(captured2.or[0][0]).toContain('created_at.lt.');
      expect(captured2.or[0][0]).toContain('id.lt.');
    });

    it('should 400 on a malformed cursor', async () => {
      mockNotificationsBuilder({ data: [], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications?cursor=not-a-cursor',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('should 400 on a foreign-scope cursor (minted for customers-list)', async () => {
      mockNotificationsBuilder({ data: [], error: null });
      const cursor = Buffer.from(
        JSON.stringify({
          id: NOTIF_A,
          createdAt: '2026-09-09T10:00:00Z',
          scope: 'customers-list',
        }),
      ).toString('base64url');

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/notifications?cursor=${cursor}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should return 200 with an empty list for a technician JWT (never an error, never another recipient's rows)", async () => {
      const { captured } = mockNotificationsBuilder({ data: [], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
      // Scoped to the technician's own sub — isolation is recipient-scoping.
      expect(captured.eq).toContainEqual(['user_id', TECH_ID]);
    });

    it('should short-circuit to an empty page without any DB call when tenantId is null', async () => {
      const from = jest.fn();
      mockCreateAdmin.mockReturnValue({ from });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/notifications/unread-count', () => {
    it('should count only read_at IS NULL rows for the recipient', async () => {
      const { captured } = mockNotificationsBuilder({
        data: null,
        error: null,
        count: 2,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications/unread-count',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ unreadCount: 2 });
      expect(captured.select[0]).toEqual([
        'id',
        { count: 'exact', head: true },
      ]);
      expect(captured.is[0]).toEqual(['read_at', null]);
      expect(captured.eq).toContainEqual(['user_id', OWNER_ID]);
    });

    it('should short-circuit to 0 without any DB call when tenantId is null', async () => {
      const from = jest.fn();
      mockCreateAdmin.mockReturnValue({ from });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications/unread-count',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ unreadCount: 0 });
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/notifications/mark-read', () => {
    it('should mark own unread rows only and report the count actually marked', async () => {
      const { captured } = mockNotificationsBuilder({
        data: [{ id: NOTIF_A }], // the foreign/unread/already-read ids no-op
        error: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/mark-read',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ids: [NOTIF_A, NOTIF_B] },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ markedCount: 1 });
      expect(captured.update[0][0]).toHaveProperty('read_at');
      expect(captured.in[0][0]).toBe('id');
      expect(captured.in[0][1]).toEqual([NOTIF_A, NOTIF_B]);
      expect(captured.is[0]).toEqual(['read_at', null]);
      expect(captured.eq).toContainEqual(['tenant_id', TENANT_ID]);
      expect(captured.eq).toContainEqual(['user_id', OWNER_ID]);
    });

    it('should accept a whitespace-padded UUID — trimArray runs before @IsUUID', async () => {
      const { captured } = mockNotificationsBuilder({
        data: [{ id: NOTIF_A }],
        error: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/mark-read',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ids: [`  ${NOTIF_A}  `] },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ markedCount: 1 });
      // The trim happened — the query receives the cleaned id, not the padded one.
      expect(captured.in[0][1]).toEqual([NOTIF_A]);
    });

    it('should short-circuit to 0 without any DB call when tenantId is null', async () => {
      const from = jest.fn();
      mockCreateAdmin.mockReturnValue({ from });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/mark-read',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
        payload: { ids: [NOTIF_A] },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ markedCount: 0 });
      expect(from).not.toHaveBeenCalled();
    });

    // Parametrized 422 batch — the house style (mirrors the structured-address
    // batch in jobs.e2e-spec.ts). All client-controlled-input bounds.
    it.each([
      ['an empty ids array', { ids: [] }],
      ['a missing ids field', {}],
      ['a non-array ids field', { ids: 'not-an-array' }],
      ['a non-UUID id', { ids: ['not-a-uuid'] }],
      ['more than 100 ids', { ids: Array(101).fill(NOTIF_A) }],
    ])('should 422 on %s', async (_label, payload) => {
      const from = jest.fn();
      mockCreateAdmin.mockReturnValue({ from });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/mark-read',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload,
      });

      expect(response.statusCode).toBe(422);
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/notifications/mark-all-read', () => {
    it('should mark every own unread row (no id filter) and report the count', async () => {
      const { captured } = mockNotificationsBuilder({
        data: [{ id: NOTIF_A }, { id: NOTIF_B }],
        error: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/mark-all-read',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ markedCount: 2 });
      expect(captured.update[0][0]).toHaveProperty('read_at');
      expect(captured.is[0]).toEqual(['read_at', null]);
      expect(captured.in).toHaveLength(0); // no id filter on mark-all
      expect(captured.eq).toContainEqual(['tenant_id', TENANT_ID]);
      expect(captured.eq).toContainEqual(['user_id', OWNER_ID]);
    });

    it('should be idempotent — a repeat run marks 0', async () => {
      mockNotificationsBuilder({ data: [], error: null });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/mark-all-read',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ markedCount: 0 });
    });

    it('should short-circuit to 0 without any DB call when tenantId is null', async () => {
      const from = jest.fn();
      mockCreateAdmin.mockReturnValue({ from });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/mark-all-read',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ markedCount: 0 });
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/notifications (validation)', () => {
    it.each([
      ['limit=999', 'limit=999'],
      ['limit=0', 'limit=0'],
      ['limit=51', 'limit=51'],
      ['limit=abc', 'limit=abc'],
    ])('should 422 on %s', async (_label, qs) => {
      const from = jest.fn();
      mockCreateAdmin.mockReturnValue({ from });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/notifications?${qs}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(422);
      expect(from).not.toHaveBeenCalled();
    });
  });

  // Auth is a global APP_GUARD — one 401 pass per method shape, house style
  // (mirrors the AC6/AC9 401 cases in customers.e2e-spec.ts).
  describe('auth', () => {
    it.each([
      ['GET /notifications', { method: 'GET', url: '/api/v1/notifications' }],
      [
        'GET /notifications/unread-count',
        { method: 'GET', url: '/api/v1/notifications/unread-count' },
      ],
      [
        'POST /notifications/mark-read',
        {
          method: 'POST',
          url: '/api/v1/notifications/mark-read',
          payload: { ids: [NOTIF_A] },
        },
      ],
      [
        'POST /notifications/mark-all-read',
        { method: 'POST', url: '/api/v1/notifications/mark-all-read' },
      ],
    ])('should return 401 with no JWT on %s', async (_label, request) => {
      const from = jest.fn();
      mockCreateAdmin.mockReturnValue({ from });

      const response = await app.inject({
        ...(request as Record<string, unknown>),
        headers: {},
      } as never);

      expect(response.statusCode).toBe(401);
      expect(from).not.toHaveBeenCalled();
    });
  });
});
