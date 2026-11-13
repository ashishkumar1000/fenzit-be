import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import {
  compareVersionNames,
  PlayConsoleVersionService,
  PlayUnavailableError,
} from '../play-console/play-console-version.service';
import { AppRoadblocksConfigDto } from './dto/app-roadblocks-config.dto';

/** The app_config keys behind the roadblock screens, per platform. */
const KEYS = {
  android: {
    minVersion: 'min_supported_version_android',
    message: 'force_update_message_android',
    storeUrl: 'store_url_android',
  },
  ios: {
    minVersion: 'min_supported_version_ios',
    message: 'force_update_message_ios',
    storeUrl: 'store_url_ios',
  },
  support: { email: 'support_email', phone: 'support_phone' },
} as const;

const ALL_KEYS: string[] = [
  KEYS.android.minVersion,
  KEYS.android.message,
  KEYS.android.storeUrl,
  KEYS.ios.minVersion,
  KEYS.ios.message,
  KEYS.ios.storeUrl,
  KEYS.support.email,
  KEYS.support.phone,
];

/** Read shape (and PUT echo): values are null when a row is missing. */
export interface AppRoadblocksConfigView {
  android: {
    minVersion: string | null;
    message: string | null;
    storeUrl: string | null;
  };
  ios: {
    minVersion: string | null;
    message: string | null;
    storeUrl: string | null;
  };
  support: { email: string | null; phone: string | null };
  /**
   * The Android version live on Google Play, or null when Play cannot be asked
   * right now. Read-only. Absent on a save response: a save does not ask Play.
   */
  liveAndroidVersion?: string | null;
}

@Injectable()
export class AdminConfigService {
  private readonly logger = new Logger(AdminConfigService.name);

  constructor(
    private readonly supabaseFactory: SupabaseClientFactory,
    private readonly playConsole: PlayConsoleVersionService,
  ) {}

  /** The stored config plus the live Play version, for the admin page. */
  async getAppRoadblocks(): Promise<AppRoadblocksConfigView> {
    const stored = await this.readStoredRoadblocks();
    let liveAndroidVersion: string | null = null;
    try {
      liveAndroidVersion = await this.playConsole.latestLiveAndroidVersion();
    } catch (error) {
      // The page still loads without the reference; the save path refuses on its own.
      const reason =
        error instanceof PlayUnavailableError
          ? error.message
          : error instanceof Error
            ? error.name
            : 'unknown error';
      this.logger.warn(`Live Android version unavailable: ${reason}`);
    }
    return { ...stored, liveAndroidVersion };
  }

  /** Reads straight from the table (not the app's cache), so the form shows the truth. */
  private async readStoredRoadblocks(): Promise<
    Omit<AppRoadblocksConfigView, 'liveAndroidVersion'>
  > {
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('app_config')
      .select('key, value')
      .in('key', ALL_KEYS);
    if (error || !data) {
      this.logger.error('Failed to read roadblock config:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to read the roadblock config',
      });
    }
    const values = new Map<string, string | null>();
    for (const row of data as Array<{ key: string; value: unknown }>) {
      values.set(row.key, typeof row.value === 'string' ? row.value : null);
    }
    const get = (key: string) => values.get(key) ?? null;
    return {
      android: {
        minVersion: get(KEYS.android.minVersion),
        message: get(KEYS.android.message),
        storeUrl: get(KEYS.android.storeUrl),
      },
      ios: {
        minVersion: get(KEYS.ios.minVersion),
        message: get(KEYS.ios.message),
        storeUrl: get(KEYS.ios.storeUrl),
      },
      support: {
        email: get(KEYS.support.email),
        phone: get(KEYS.support.phone),
      },
    };
  }

  /**
   * Writes all roadblock keys in one upsert (one statement, so it is
   * all-or-nothing). The legacy keys min_supported_version and
   * force_update_message are no longer written: they used to copy the Android
   * values, which blocked iOS builds with Android's rule. Old binaries that
   * still read them see the value left in the database.
   */
  async saveAppRoadblocks(
    actorId: string,
    dto: AppRoadblocksConfigDto,
  ): Promise<AppRoadblocksConfigView> {
    // The Android minimum must not be above the version live on Google Play.
    // Checked only when it changes, so unrelated edits never depend on Play.
    const stored = await this.readStoredRoadblocks();
    if (dto.android.minVersion !== stored.android.minVersion) {
      await this.assertNotAboveLivePlayVersion(dto.android.minVersion);
    }

    const now = new Date().toISOString();
    const pairs: Array<[string, string]> = [
      [KEYS.android.minVersion, dto.android.minVersion],
      [KEYS.android.message, dto.android.message],
      [KEYS.android.storeUrl, dto.android.storeUrl],
      [KEYS.ios.minVersion, dto.ios.minVersion],
      [KEYS.ios.message, dto.ios.message],
      [KEYS.ios.storeUrl, dto.ios.storeUrl],
      [KEYS.support.email, dto.support.email],
      [KEYS.support.phone, dto.support.phone],
    ];
    const rows = pairs.map(([key, value]) => ({ key, value, updated_at: now }));

    const { error } = await this.supabaseFactory
      .createAdmin()
      .from('app_config')
      .upsert(rows, { onConflict: 'key' });
    if (error) {
      this.logger.error('Failed to save roadblock config:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to save the roadblock config',
      });
    }

    // Audit line: who changed which keys. Values are not logged.
    this.logger.log(
      `Roadblock config saved by ${actorId}; keys: ${pairs.map(([k]) => k).join(', ')}`,
    );
    // The save answers with the stored values only; it does not ask Google Play.
    return this.readStoredRoadblocks();
  }

  /**
   * Refuses an Android minimum that is newer than the live Play version: users
   * would be locked out with no build to update to. Play unreachable → 502, so
   * the admin retries; nothing is saved on a guess.
   */
  private async assertNotAboveLivePlayVersion(
    minVersion: string,
  ): Promise<void> {
    let live: string;
    try {
      live = await this.playConsole.latestLiveAndroidVersion();
    } catch (error) {
      const reason =
        error instanceof PlayUnavailableError
          ? error.message
          : `unexpected ${(error as Error).name}`;
      this.logger.error(`Play version check failed: ${reason}`);
      throw new BadGatewayException({
        error_code: ErrorCode.PLAY_UPSTREAM_ERROR,
        message:
          "Can't check Google Play right now. Try saving again in a minute.",
      });
    }
    if (compareVersionNames(minVersion, live) > 0) {
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message: `Version ${minVersion} isn't live on Google Play yet. The latest live Android version is ${live}.`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }
}
