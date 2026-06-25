import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

// Mock AWS SDK modules before importing the service
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input) => ({ input, type: 'put' })),
  GetObjectCommand: jest
    .fn()
    .mockImplementation((input) => ({ input, type: 'get' })),
}));

const mockGetSignedUrl = jest
  .fn()
  .mockResolvedValue('https://r2.example.com/signed');
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

describe('StorageService', () => {
  let service: StorageService;

  const mockConfig = {
    getOrThrow: jest.fn((key: string) => {
      const vals: Record<string, string> = {
        CLOUDFLARE_R2_BUCKET: 'test-bucket',
        CLOUDFLARE_R2_ACCOUNT_ID: 'account-123',
        CLOUDFLARE_R2_ACCESS_KEY: 'key',
        CLOUDFLARE_R2_SECRET_KEY: 'secret',
      };
      return (
        vals[key] ??
        (() => {
          throw new Error(`missing ${key}`);
        })()
      );
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
    mockGetSignedUrl.mockClear();
  });

  it('getPresignedUploadUrl calls getSignedUrl with PutObjectCommand and correct expiresIn', async () => {
    const url = await service.getPresignedUploadUrl(
      'tenant/jobs/job1/photos/uuid.jpg',
      'image/jpeg',
      900,
    );

    expect(url).toBe('https://r2.example.com/signed');
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const [, cmd, opts] = mockGetSignedUrl.mock.calls[0] as [
      unknown,
      { type: string },
      { expiresIn: number; signableHeaders: Set<string> },
    ];
    expect(cmd.type).toBe('put');
    expect(opts.expiresIn).toBe(900);
    expect(opts.signableHeaders).toBeInstanceOf(Set);
    expect(opts.signableHeaders.has('content-type')).toBe(true);
  });

  it('getPresignedReadUrl calls getSignedUrl with GetObjectCommand and correct expiresIn', async () => {
    const url = await service.getPresignedReadUrl(
      'tenant/jobs/job1/photos/uuid.jpg',
      3600,
    );

    expect(url).toBe('https://r2.example.com/signed');
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const [, cmd, opts] = mockGetSignedUrl.mock.calls[0] as [
      unknown,
      { type: string },
      { expiresIn: number },
    ];
    expect(cmd.type).toBe('get');
    expect(opts.expiresIn).toBe(3600);
  });
});
