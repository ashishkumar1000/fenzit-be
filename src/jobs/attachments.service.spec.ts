import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttachmentsService } from './attachments.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { StorageService } from '../storage/storage.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { AttachmentType } from './dto/upload-attachment.dto';
import { ConfirmAttachmentDto } from './dto/confirm-attachment.dto';

describe('AttachmentsService', () => {
  let service: AttachmentsService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let storageService: jest.Mocked<StorageService>;

  // Build the service with an optional configured max size (default: unset → 50 MB).
  async function buildService(maxSizeBytes?: number) {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    const mockStorage = {
      getPresignedUploadUrl: jest
        .fn()
        .mockResolvedValue('https://r2.example.com/presigned'),
      getPresignedReadUrl: jest
        .fn()
        .mockResolvedValue('https://r2.example.com/read'),
    };
    const mockConfig = { get: jest.fn().mockReturnValue(maxSizeBytes) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttachmentsService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: StorageService, useValue: mockStorage },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<AttachmentsService>(AttachmentsService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
    storageService = module.get(StorageService);
  }

  const tech: RequestUser = {
    userId: 'tech-1',
    tenantId: 'tenant-uuid',
    role: Role.TECHNICIAN,
    rawJwt: 'jwt',
  };
  const techNoTenant: RequestUser = { ...tech, tenantId: null };

  const baseJob = {
    id: 'job-uuid',
    tenant_id: 'tenant-uuid',
    technician_id: 'tech-1',
  };

  const photoDto = {
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    attachmentType: AttachmentType.PHOTO,
  };
  const sigDto = {
    filename: 'sig.png',
    mimeType: 'image/png',
    attachmentType: AttachmentType.SIGNATURE,
  };
  const confirmDto: ConfirmAttachmentDto = { sizeBytes: 12345 };

  // Builds a chain: select().eq().eq().single() → resolves to result
  function makeJobChain(result: unknown) {
    const single = jest.fn().mockResolvedValue(result);
    const eq2 = jest.fn().mockReturnValue({ single });
    const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
    const select = jest.fn().mockReturnValue({ eq: eq1 });
    return select;
  }

  // Builds a chain: select().eq().eq().eq() → resolves to result (count query, no single)
  function makeCountChain(result: unknown) {
    const eq3 = jest.fn().mockResolvedValue(result);
    const eq2 = jest.fn().mockReturnValue({ eq: eq3 });
    const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
    const select = jest.fn().mockReturnValue({ eq: eq1 });
    return select;
  }

  // Builds a chain: insert() → resolves to result
  function makeInsertFn(result: unknown) {
    return jest.fn().mockResolvedValue(result);
  }

  function mockAdmin(opts: {
    job?: unknown;
    count?: unknown;
    insert?: unknown;
    rpc?: unknown;
  }) {
    const jobSelect = makeJobChain(opts.job ?? { data: baseJob, error: null });
    const countSelect = makeCountChain(opts.count ?? { count: 0, error: null });
    const insertFn = makeInsertFn(
      opts.insert ?? { data: { id: 'upload-uuid' }, error: null },
    );

    const rpc = jest.fn().mockResolvedValue(
      opts.rpc ?? {
        data: [
          {
            attachment_id: 'att-uuid',
            attachment_type: 'photo',
            created_at: '2026-06-21T00:00:00Z',
            already_existed: false,
          },
        ],
        error: null,
      },
    );

    const from = jest.fn((table: string) => {
      if (table === 'jobs') return { select: jobSelect };
      if (table === 'attachments') return { select: countSelect };
      if (table === 'attachment_uploads') return { insert: insertFn };
      throw new Error(`unexpected table ${table}`);
    });
    supabaseClientFactory.createAdmin.mockReturnValue({ from, rpc } as never);
    return { from, rpc };
  }

  beforeEach(async () => {
    await buildService();
  });

  describe('requestUpload', () => {
    it('photo request — returns presignedPutUrl, uploadId; key contains photos/ and .jpg', async () => {
      mockAdmin({});
      const res = await service.requestUpload(tech, 'job-uuid', photoDto);

      expect(res.presignedPutUrl).toBe('https://r2.example.com/presigned');
      expect(res.uploadId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.key).toContain('/photos/');
      expect(res.key).toMatch(/\.jpg$/);
      expect(res.expiresAt).toBeTruthy();
      expect(storageService.getPresignedUploadUrl).toHaveBeenCalledWith(
        expect.stringContaining('/photos/'),
        'image/jpeg',
        900,
      );
    });

    it('signature request — key contains signature/ and .png', async () => {
      mockAdmin({});
      const res = await service.requestUpload(tech, 'job-uuid', sigDto);

      expect(res.key).toContain('/signature/');
      expect(res.key).toMatch(/\.png$/);
    });

    it('5-photo gate → 409 DUPLICATE_RESOURCE', async () => {
      mockAdmin({ count: { count: 5, error: null } });
      await expect(
        service.requestUpload(tech, 'job-uuid', photoDto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('job not found (PGRST116) → 404', async () => {
      mockAdmin({ job: { data: null, error: { code: 'PGRST116' } } });
      await expect(
        service.requestUpload(tech, 'job-uuid', photoDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-assignee technician → 403', async () => {
      mockAdmin({
        job: { data: { ...baseJob, technician_id: 'other-tech' }, error: null },
      });
      await expect(
        service.requestUpload(tech, 'job-uuid', photoDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('no tenant → 400 VALIDATION_ERROR', async () => {
      await expect(
        service.requestUpload(techNoTenant, 'job-uuid', photoDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('real DB error on fetch → 500', async () => {
      mockAdmin({ job: { data: null, error: { code: 'XX000' } } });
      await expect(
        service.requestUpload(tech, 'job-uuid', photoDto),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('confirmUpload', () => {
    it('happy path → { id, type, createdAt }', async () => {
      mockAdmin({});
      const res = await service.confirmUpload(
        tech,
        'job-uuid',
        'upload-uuid',
        confirmDto,
      );

      expect(res).toEqual({
        id: 'att-uuid',
        type: 'photo',
        createdAt: '2026-06-21T00:00:00Z',
      });
    });

    it('UPLOAD_EXPIRED → 410 GONE', async () => {
      mockAdmin({ rpc: { data: null, error: { message: 'UPLOAD_EXPIRED' } } });
      const err = await service
        .confirmUpload(tech, 'job-uuid', 'upload-uuid', confirmDto)
        .catch((e) => e);
      expect(err.status).toBe(HttpStatus.GONE);
    });

    it('UPLOAD_NOT_FOUND → 404', async () => {
      mockAdmin({
        rpc: { data: null, error: { message: 'UPLOAD_NOT_FOUND' } },
      });
      await expect(
        service.confirmUpload(tech, 'job-uuid', 'upload-uuid', confirmDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('already-confirmed (already_existed=true) → 200 with original row (idempotent)', async () => {
      mockAdmin({
        rpc: {
          data: [
            {
              attachment_id: 'att-uuid',
              attachment_type: 'photo',
              created_at: '2026-06-21T00:00:00Z',
              already_existed: true,
            },
          ],
          error: null,
        },
      });
      const res = await service.confirmUpload(
        tech,
        'job-uuid',
        'upload-uuid',
        confirmDto,
      );
      expect(res.id).toBe('att-uuid');
    });

    it('job not found → 404', async () => {
      mockAdmin({ job: { data: null, error: { code: 'PGRST116' } } });
      await expect(
        service.confirmUpload(tech, 'job-uuid', 'upload-uuid', confirmDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-assignee → 403', async () => {
      mockAdmin({
        job: { data: { ...baseJob, technician_id: 'other' }, error: null },
      });
      await expect(
        service.confirmUpload(tech, 'job-uuid', 'upload-uuid', confirmDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('no tenant → 400', async () => {
      await expect(
        service.confirmUpload(
          techNoTenant,
          'job-uuid',
          'upload-uuid',
          confirmDto,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rpc unknown error → 500', async () => {
      mockAdmin({
        rpc: {
          data: null,
          error: { message: 'some other error', code: 'XX000' },
        },
      });
      await expect(
        service.confirmUpload(tech, 'job-uuid', 'upload-uuid', confirmDto),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('PHOTO_LIMIT_EXCEEDED → 409 DUPLICATE_RESOURCE', async () => {
      mockAdmin({
        rpc: { data: null, error: { message: 'PHOTO_LIMIT_EXCEEDED' } },
      });
      await expect(
        service.confirmUpload(tech, 'job-uuid', 'upload-uuid', confirmDto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('empty RPC result set → 404 (no null dereference)', async () => {
      mockAdmin({ rpc: { data: [], error: null } });
      await expect(
        service.confirmUpload(tech, 'job-uuid', 'upload-uuid', confirmDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('RPC row with null attachment_id → 404 (dangling confirmed staging row)', async () => {
      mockAdmin({
        rpc: {
          data: [
            {
              attachment_id: null,
              attachment_type: 'photo',
              created_at: null,
              already_existed: true,
            },
          ],
          error: null,
        },
      });
      await expect(
        service.confirmUpload(tech, 'job-uuid', 'upload-uuid', confirmDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('size over default 50 MB limit → 400 VALIDATION_ERROR (no RPC call)', async () => {
      const { rpc } = mockAdmin({});
      await expect(
        service.confirmUpload(tech, 'job-uuid', 'upload-uuid', {
          sizeBytes: 50 * 1024 * 1024 + 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('size limit is configurable via MAX_ATTACHMENT_SIZE_BYTES', async () => {
      await buildService(1000); // 1 KB cap
      const { rpc } = mockAdmin({});
      await expect(
        service.confirmUpload(tech, 'job-uuid', 'upload-uuid', {
          sizeBytes: 2000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});
