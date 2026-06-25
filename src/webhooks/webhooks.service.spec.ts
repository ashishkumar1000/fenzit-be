import { Test, TestingModule } from '@nestjs/testing';
import {
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { StorageEventDto } from './dto/storage-event.dto';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;

  const SECRET = 'test-webhook-secret-value';

  const dto: StorageEventDto = {
    key: 'tenant-uuid/jobs/job-uuid/photos/upload-uuid.jpg',
    size: 12345,
    tenantId: 'tenant-uuid',
    jobId: 'job-uuid',
    attachmentType: 'photo',
  };

  const successRpcResult = {
    data: [{ attachment_id: 'att-uuid', attachment_type: 'photo' }],
    error: null,
  };

  function mockAdmin(rpcResult: unknown) {
    const rpc = jest.fn().mockResolvedValue(rpcResult);
    supabaseClientFactory.createAdmin.mockReturnValue({ rpc } as never);
    return { rpc };
  }

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    const mockConfig = {
      getOrThrow: jest.fn().mockReturnValue(SECRET),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  it('valid secret + photo → rpc called with correct params, returns void', async () => {
    const { rpc } = mockAdmin(successRpcResult);

    await expect(
      service.handleStorageEvent(`Bearer ${SECRET}`, dto),
    ).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledWith('confirm_attachment', {
      p_upload_id: 'upload-uuid',
      p_job_id: 'job-uuid',
      p_tenant_id: 'tenant-uuid',
      p_size_bytes: 12345,
      p_actor_id: null,
    });
  });

  it('invalid secret → 401 UnauthorizedException', async () => {
    mockAdmin(successRpcResult);
    await expect(
      service.handleStorageEvent('Bearer wrong-secret', dto),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('missing auth header → 401 UnauthorizedException', async () => {
    mockAdmin(successRpcResult);
    await expect(
      service.handleStorageEvent(undefined, dto),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rpc UPLOAD_EXPIRED → logs warning, returns void (ack, no retry)', async () => {
    mockAdmin({ data: null, error: { message: 'UPLOAD_EXPIRED' } });
    await expect(
      service.handleStorageEvent(`Bearer ${SECRET}`, dto),
    ).resolves.toBeUndefined();
  });

  it('rpc UPLOAD_NOT_FOUND → logs warning, returns void (ack, no retry)', async () => {
    mockAdmin({ data: null, error: { message: 'UPLOAD_NOT_FOUND' } });
    await expect(
      service.handleStorageEvent(`Bearer ${SECRET}`, dto),
    ).resolves.toBeUndefined();
  });

  it('rpc unknown error → 500 InternalServerErrorException', async () => {
    mockAdmin({
      data: null,
      error: { message: 'connection refused', code: 'XX000' },
    });
    await expect(
      service.handleStorageEvent(`Bearer ${SECRET}`, dto),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('rpc PHOTO_LIMIT_EXCEEDED → logs warning, returns void (ack, no retry)', async () => {
    mockAdmin({ data: null, error: { message: 'PHOTO_LIMIT_EXCEEDED' } });
    await expect(
      service.handleStorageEvent(`Bearer ${SECRET}`, dto),
    ).resolves.toBeUndefined();
  });

  it('key/body tenant mismatch → returns void without calling RPC (defense-in-depth)', async () => {
    const { rpc } = mockAdmin(successRpcResult);
    await expect(
      service.handleStorageEvent(`Bearer ${SECRET}`, {
        ...dto,
        tenantId: 'other-tenant-uuid',
      }),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('key/body jobId mismatch → returns void without calling RPC', async () => {
    const { rpc } = mockAdmin(successRpcResult);
    await expect(
      service.handleStorageEvent(`Bearer ${SECRET}`, {
        ...dto,
        jobId: 'other-job-uuid',
      }),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });
});
