import 'reflect-metadata';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

// Nest route metadata keys (mirror of @nestjs/common/constants — imported
// values, not literals, per auth.controller.spec.ts's metadata-reflection style).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const HTTP_CODE_METADATA = '__httpCode__';
const INTERCEPTORS_METADATA = '__interceptors__';

describe('ReportsController — retry route (POST :id/retry)', () => {
  const user: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const REQUEST_ID = '00000000-0000-4000-8000-0000000000a1';

  it('delegates to ReportsService.retryReport with the current user and the parsed id', async () => {
    const queued = {
      id: REQUEST_ID,
      status: 'queued',
      createdAt: '2026-09-10T10:00:00Z',
    };
    const retryReport = jest.fn().mockResolvedValue(queued);
    const controller = new ReportsController({
      retryReport,
    } as unknown as ReportsService);

    await expect(controller.retryReport(user, REQUEST_ID)).resolves.toBe(queued);
    expect(retryReport).toHaveBeenCalledWith(user, REQUEST_ID);
  });

  it('is owner-only — a technician must never be able to re-queue a report', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      ReportsController.prototype.retryReport,
    ) as Role[] | undefined;

    expect(roles).toEqual([Role.OWNER]);
  });

  it('is wired as POST reports/:id/retry', () => {
    const handler = ReportsController.prototype.retryReport;

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/retry');
    // 1 = RequestMethod.POST
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(1);
  });

  it('returns 201 on success (not the default 202 for POST)', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, ReportsController.prototype.retryReport),
    ).toBe(201);
  });

  it('runs the IdempotencyInterceptor', () => {
    const interceptors = Reflect.getMetadata(
      INTERCEPTORS_METADATA,
      ReportsController.prototype.retryReport,
    ) as unknown[];

    expect(interceptors).toContain(IdempotencyInterceptor);
  });
});

describe('ReportsController — create/list/status routes (story 12-2)', () => {
  const user: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const REQUEST_ID = '00000000-0000-4000-8000-0000000000b2';
  const dto = { startDate: '2026-08-01', endDate: '2026-08-07' };
  const query = { cursor: 'cXVlcnk' };

  function controllerWith(service: Partial<ReportsService>) {
    return new ReportsController(service as unknown as ReportsService);
  }

  describe('delegation', () => {
    it('createReport passes the current user and the body dto straight through', async () => {
      const created = { id: REQUEST_ID, status: 'queued', createdAt: 'x' };
      const createReport = jest.fn().mockResolvedValue(created);
      const controller = controllerWith({ createReport });

      await expect(controller.createReport(user, dto as never)).resolves.toBe(
        created,
      );
      expect(createReport).toHaveBeenCalledWith(user, dto);
    });

    it('listReports passes the current user and the parsed query dto', async () => {
      const page = { data: [], nextCursor: null, hasMore: false };
      const listReports = jest.fn().mockResolvedValue(page);
      const controller = controllerWith({ listReports });

      await expect(
        controller.listReports(user, query as never),
      ).resolves.toBe(page);
      expect(listReports).toHaveBeenCalledWith(user, query);
    });

    it('getReportStatus passes the current user and the parsed id', async () => {
      const status = { id: REQUEST_ID, status: 'ready' };
      const getReportStatus = jest.fn().mockResolvedValue(status);
      const controller = controllerWith({ getReportStatus });

      await expect(
        controller.getReportStatus(user, REQUEST_ID),
      ).resolves.toBe(status);
      expect(getReportStatus).toHaveBeenCalledWith(user, REQUEST_ID);
    });
  });

  describe('createReport (POST /reports)', () => {
    const handler = ReportsController.prototype.createReport;

    it('is owner-only', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, handler) as Role[];
      expect(roles).toEqual([Role.OWNER]);
    });

    it('is wired as POST reports with an explicit 201', () => {
      // Nest normalizes the parameterless sub-path to "/".
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(1); // POST
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(201);
    });

    it('runs the IdempotencyInterceptor', () => {
      const interceptors = Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        handler,
      ) as unknown[];
      expect(interceptors).toContain(IdempotencyInterceptor);
    });
  });

  describe('listReports (GET /reports)', () => {
    const handler = ReportsController.prototype.listReports;

    it('is owner-only', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, handler) as Role[];
      expect(roles).toEqual([Role.OWNER]);
    });

    it('is wired as GET reports with the default 200', () => {
      // Nest normalizes the parameterless sub-path to "/".
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0); // GET
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    });
  });

  describe('getReportStatus (GET /reports/:id)', () => {
    const handler = ReportsController.prototype.getReportStatus;

    it('is owner-only', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, handler) as Role[];
      expect(roles).toEqual([Role.OWNER]);
    });

    it('is wired as GET reports/:id with 200', () => {
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0); // GET
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    });
  });
});