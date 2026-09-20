import { Test, TestingModule } from '@nestjs/testing';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../../common/factories/supabase-client.factory';
import { StorageService } from '../../storage/storage.service';
import { ReportRegistry } from '../registry/report-registry';
import { ReportDefinition } from '../registry/report-definition';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { ReportRequestStatus } from '../enums/report-status.enum';
import { ReportRequestRow } from '../report-response.model';
import { PDF_RENDERER } from './pdf-renderer.port';
import { ReportPipelineService } from './report-pipeline.service';

/**
 * The guarded-UPDATE chain of the terminal stamps: update(...).eq(...).eq(...)
 * awaited directly (claims add .select('*'), stamps don't) — thenable
 * resolving `result`, matching reports.service.spec.ts's updateChain.
 */
function updateQb(result: { data: unknown; error: unknown }) {
  const qb: Record<string, jest.Mock> & { then: jest.Mock } = {} as never;
  for (const m of ['update', 'eq', 'lt', 'select']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.then = jest.fn((resolve: (v: unknown) => unknown) => resolve(result));
  return qb;
}

const TENANT_ID = 'tenant-uuid';
const REQUEST_ID = '00000000-0000-4000-8000-0000000000d1';

const queuedRow: ReportRequestRow = {
  id: REQUEST_ID,
  tenant_id: TENANT_ID,
  requested_by: 'owner-uuid',
  report_type: 'technician_job_activity',
  params: {
    start_date: '2026-09-01',
    end_date: '2026-09-07',
    technician_ids: [],
  },
  status: ReportRequestStatus.GENERATING,
  attempt_count: 1,
  locked_until: '2026-09-20T10:05:00.000Z',
  r2_key: null,
  file_size_bytes: null,
  error_code: null,
  created_at: '2026-09-20T10:00:00.000Z',
  completed_at: null,
};

const PDF_BYTES = Buffer.from('%PDF-1.4 mock report bytes');

/** Fresh definition per test — mockRejectedValue must never leak between tests. */
function makeDefinition(): ReportDefinition & {
  fetchData: jest.Mock;
  buildDocument: jest.Mock;
} {
  return {
    type: 'technician_job_activity',
    label: 'Technician Job Activity',
    validateParams: jest.fn(),
    fetchData: jest.fn().mockResolvedValue({ jobs: [{ id: 'job-1' }] }),
    buildDocument: jest.fn().mockReturnValue({ content: [{ text: 'hi' }] }),
  } as never;
}

describe('ReportPipelineService (story 12-3)', () => {
  let service: ReportPipelineService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let storageService: { putObject: jest.Mock };
  let registry: { get: jest.Mock };
  let renderer: { render: jest.Mock };
  let config: { get: jest.Mock };
  let definition: ReturnType<typeof makeDefinition>;

  /** The single update chain the current run issues (ready or failed stamp). */
  let updateQbs: ReturnType<typeof updateQb>[];

  function mockAdmin() {
    updateQbs = [];
    const from = jest.fn((table: string) => {
      if (table !== 'report_requests') {
        throw new Error(`unexpected table ${table}`);
      }
      const qb = updateQb({ data: null, error: null });
      updateQbs.push(qb);
      return qb;
    });
    supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
    return { from };
  }

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    definition = makeDefinition();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportPipelineService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: StorageService, useValue: { putObject: jest.fn() } },
        { provide: ReportRegistry, useValue: { get: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (key: string) => ({ REPORT_MAX_JOBS: 4321 } as Record<string, unknown>)[key],
            ),
          },
        },
        {
          provide: PDF_RENDERER,
          useValue: { render: jest.fn().mockResolvedValue(PDF_BYTES) },
        },
      ],
    }).compile();

    service = module.get<ReportPipelineService>(ReportPipelineService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
    storageService = module.get(StorageService);
    registry = module.get(ReportRegistry);
    renderer = module.get(PDF_RENDERER);
    config = module.get(ConfigService);
    registry.get.mockReturnValue(definition);
  });

  describe('happy path', () => {
    it('fetches → builds → renders → uploads → stamps ready end to end', async () => {
      mockAdmin();

      await service.run(queuedRow);

      // Registry resolved the definition for the row's report_type.
      expect(registry.get).toHaveBeenCalledWith('technician_job_activity');
      // The renderer got the document the definition built from the fetch.
      expect(definition.buildDocument).toHaveBeenCalledWith({
        jobs: [{ id: 'job-1' }],
      });
      expect(renderer.render).toHaveBeenCalledWith({
        content: [{ text: 'hi' }],
      });
      // putObject got the rendered bytes at the deterministic R2 key.
      expect(storageService.putObject).toHaveBeenCalledTimes(1);
      expect(storageService.putObject).toHaveBeenCalledWith(
        `${TENANT_ID}/reports/${REQUEST_ID}.pdf`,
        'application/pdf',
        PDF_BYTES,
      );
    });

    it('hands the definition a complete tenant-scoped fetch context', async () => {
      const { from } = mockAdmin();

      await service.run(queuedRow);

      expect(definition.fetchData).toHaveBeenCalledWith({
        supabase: expect.objectContaining({ from }),
        tenantId: TENANT_ID,
        requestId: REQUEST_ID,
        params: queuedRow.params,
        maxJobs: 4321,
      });
    });

    it('stamps the row ready with r2_key + file_size_bytes + completed_at (FR-4)', async () => {
      mockAdmin();

      await service.run(queuedRow);

      // Ready stamp strictly after the upload — one guarded UPDATE.
      expect(storageService.putObject).toHaveBeenCalled();
      expect(updateQbs).toHaveLength(1);
      const qb = updateQbs[0];
      expect(qb.update).toHaveBeenCalledWith({
        status: ReportRequestStatus.READY,
        r2_key: `${TENANT_ID}/reports/${REQUEST_ID}.pdf`,
        file_size_bytes: PDF_BYTES.length,
        completed_at: expect.any(String),
      });
      expect(qb.eq).toHaveBeenCalledWith('id', REQUEST_ID);
      expect(qb.eq).toHaveBeenCalledWith(
        'status',
        ReportRequestStatus.GENERATING,
      );
    });

    it('falls back to the REPORT_MAX_JOBS default (5000) when the env is unset', async () => {
      config.get.mockReturnValue(undefined);
      mockAdmin();

      await service.run(queuedRow);

      expect(definition.fetchData).toHaveBeenCalledWith(
        expect.objectContaining({ maxJobs: 5000 }),
      );
    });
  });

  describe('definition gaps and failures → FAILED stamp', () => {
    beforeEach(() => {
      mockAdmin();
    });

    it('unregistered report type fails cleanly with REPORT_GENERATION_FAILED', async () => {
      registry.get.mockReturnValue(undefined);

      await service.run(queuedRow);

      expect(updateQbs[0].update).toHaveBeenCalledWith({
        status: ReportRequestStatus.FAILED,
        error_code: ErrorCode.REPORT_GENERATION_FAILED,
        completed_at: expect.any(String),
      });
      expect(updateQbs[0].eq).toHaveBeenCalledWith('id', REQUEST_ID);
      expect(updateQbs[0].eq).toHaveBeenCalledWith(
        'status',
        ReportRequestStatus.GENERATING,
      );
    });

    it('a half-registered definition (no fetcher / no builder yet) fails cleanly', async () => {
      registry.get.mockReturnValue({ ...definition, fetchData: undefined });

      await service.run(queuedRow);

      expect(updateQbs[0].update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ReportRequestStatus.FAILED,
          error_code: ErrorCode.REPORT_GENERATION_FAILED,
        }),
      );
      expect(renderer.render).not.toHaveBeenCalled();

      registry.get.mockReturnValue({ ...definition, buildDocument: undefined });

      await service.run(queuedRow);

      expect(renderer.render).not.toHaveBeenCalled();
      expect(updateQbs[1].update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ReportRequestStatus.FAILED,
          error_code: ErrorCode.REPORT_GENERATION_FAILED,
        }),
      );
    });

    it('a renderer throw stamps FAILED and never reaches storage', async () => {
      renderer.render.mockRejectedValue(new Error('pdf exploded'));

      await service.run(queuedRow);

      expect(storageService.putObject).not.toHaveBeenCalled();
      expect(updateQbs[0].update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ReportRequestStatus.FAILED,
          error_code: ErrorCode.REPORT_GENERATION_FAILED,
        }),
      );
    });

    it('passes a definition-mapped error_code through to the failure stamp', async () => {
      const tooLarge = Object.assign(new Error('too many jobs'), {
        response: { error_code: ErrorCode.REPORT_TOO_LARGE },
      });
      definition.fetchData.mockRejectedValue(tooLarge);

      await service.run(queuedRow);

      expect(updateQbs[0].update).toHaveBeenCalledWith(
        expect.objectContaining({ error_code: ErrorCode.REPORT_TOO_LARGE }),
      );
    });

    it('a storage upload failure stamps FAILED — never a linkless ready', async () => {
      storageService.putObject.mockRejectedValue(new Error('r2 down'));

      await service.run(queuedRow);

      expect(updateQbs).toHaveLength(1);
      expect(updateQbs[0].update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ReportRequestStatus.FAILED,
          error_code: ErrorCode.REPORT_GENERATION_FAILED,
        }),
      );
      expect(updateQbs[0].update).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: ReportRequestStatus.READY }),
      );
    });

    it('swallows a failed FAILED-stamp — run() resolves so lease recovery retries', async () => {
      registry.get.mockReturnValue(undefined);
      const qb = updateQb({ data: null, error: { message: 'stamp failed' } });
      supabaseClientFactory.createAdmin.mockReturnValue({
        from: jest.fn(() => qb),
      } as never);

      await expect(service.run(queuedRow)).resolves.toBeUndefined();
      expect(qb.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: ReportRequestStatus.FAILED }),
      );
    });
  });
});