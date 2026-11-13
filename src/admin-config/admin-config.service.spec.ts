import { BadGatewayException, HttpException } from '@nestjs/common';
import { AdminConfigService } from './admin-config.service';
import { AppRoadblocksConfigDto } from './dto/app-roadblocks-config.dto';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import {
  PlayConsoleVersionService,
  PlayUnavailableError,
} from '../play-console/play-console-version.service';

describe('AdminConfigService — Android minimum vs live Play version', () => {
  let service: AdminConfigService;
  let play: { latestLiveAndroidVersion: jest.Mock };
  let upsert: jest.Mock;
  let storedMinAndroid: string;

  beforeEach(() => {
    storedMinAndroid = '1.4.2';
    upsert = jest.fn().mockResolvedValue({ error: null });
    const from = jest.fn(() => ({
      select: jest.fn(() => ({
        in: jest.fn(() =>
          Promise.resolve({
            data: [
              { key: 'min_supported_version_android', value: storedMinAndroid },
            ],
            error: null,
          }),
        ),
      })),
      upsert,
    }));
    const factory = {
      createAdmin: jest.fn(() => ({ from })),
    } as unknown as SupabaseClientFactory;
    play = { latestLiveAndroidVersion: jest.fn().mockResolvedValue('1.4.3') };
    service = new AdminConfigService(
      factory,
      play as unknown as PlayConsoleVersionService,
    );
  });

  function dtoWithAndroidMin(minVersion: string): AppRoadblocksConfigDto {
    return {
      android: {
        minVersion,
        message: 'Please update the Fenzit app to continue.',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.fenzit',
      },
      ios: {
        minVersion: '1.0.0',
        message: 'Please update the Fenzit app to continue.',
        storeUrl: 'https://apps.apple.com/app/id0000000000',
      },
      support: { email: 'help@fenzit.com', phone: '+919999900000' },
    };
  }

  it('refuses a minimum newer than the live Play version, and writes nothing', async () => {
    const error: unknown = await service
      .saveAppRoadblocks('admin-1', dtoWithAndroidMin('1.4.4'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(422);
    expect((error as HttpException).getResponse()).toEqual(
      expect.objectContaining({
        error_code: 'VALIDATION_ERROR',
        message: expect.stringContaining('1.4.4') as unknown,
      }),
    );
    expect((error as HttpException).getResponse()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('1.4.3') as unknown,
      }),
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('compares numerically, so 1.10.0 is refused against a live 1.4.3', async () => {
    await expect(
      service.saveAppRoadblocks('admin-1', dtoWithAndroidMin('1.10.0')),
    ).rejects.toBeInstanceOf(HttpException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('accepts the exact live version', async () => {
    await service.saveAppRoadblocks('admin-1', dtoWithAndroidMin('1.4.3'));
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('accepts a minimum older than the live version', async () => {
    await service.saveAppRoadblocks('admin-1', dtoWithAndroidMin('1.4.2'));
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('does not call Play when the Android minimum is unchanged', async () => {
    storedMinAndroid = '1.4.2';

    await service.saveAppRoadblocks('admin-1', dtoWithAndroidMin('1.4.2'));

    expect(play.latestLiveAndroidVersion).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('fails closed with 502 when Play cannot be reached, and writes nothing', async () => {
    play.latestLiveAndroidVersion.mockRejectedValue(
      new PlayUnavailableError('Google Play did not answer in time'),
    );

    const error: unknown = await service
      .saveAppRoadblocks('admin-1', dtoWithAndroidMin('1.4.3'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as BadGatewayException).getStatus()).toBe(502);
    expect((error as BadGatewayException).getResponse()).toEqual(
      expect.objectContaining({ error_code: 'PLAY_UPSTREAM_ERROR' }),
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('a Play failure does not block saves that leave the Android minimum alone', async () => {
    play.latestLiveAndroidVersion.mockRejectedValue(
      new PlayUnavailableError('Google Play did not answer in time'),
    );

    await service.saveAppRoadblocks('admin-1', dtoWithAndroidMin('1.4.2'));

    expect(play.latestLiveAndroidVersion).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
