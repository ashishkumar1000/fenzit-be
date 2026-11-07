import type { ConfigService } from '@nestjs/config';
import { FcmPushSender } from './fcm-push-sender';
import { NoopPushSender } from './noop-push-sender';
import { PushSender } from './push-sender.port';

/**
 * Provider registry (the SMS module's precedent): adding a push provider
 * tomorrow = one adapter file + one entry here + its env vars. Nothing
 * else changes.
 */
const PUSH_PROVIDER_REGISTRY: Record<
  string,
  new (configService: ConfigService) => PushSender
> = {
  noop: NoopPushSender,
  fcm: FcmPushSender,
};

/**
 * The resolved provider key. The DEFAULT is noop in every environment —
 * unlike SMS there is no production auto-flip: pushes stay off until the
 * credential is mounted and the env var is set EXPLICITLY (staged rollout,
 * plan §Tasks). NODE_ENV=test needs no override for the same reason.
 */
export function resolvePushProviderKey(configService: ConfigService): string {
  return configService.get<string>('PUSH_DELIVERY_PROVIDER') ?? 'noop';
}

/**
 * Async factory (Nest supports Promise-returning useFactory) because the
 * fcm adapter loads firebase-admin lazily at init — a broken credential
 * must fail the BOOT, not the first notification.
 */
export async function createPushSender(
  configService: ConfigService,
): Promise<PushSender> {
  const key = resolvePushProviderKey(configService);
  const Adapter = PUSH_PROVIDER_REGISTRY[key];
  if (!Adapter) {
    throw new Error(`Unknown PUSH_DELIVERY_PROVIDER: ${key}`);
  }
  // Joi already requires GOOGLE_APPLICATION_CREDENTIALS when the var is
  // explicitly 'fcm' — this second check covers an env where validation
  // was bypassed (PRD FR-BE3's principle: bad config = boot error, not a
  // runtime push outage).
  if (
    key === 'fcm' &&
    !configService.get<string>('GOOGLE_APPLICATION_CREDENTIALS')
  ) {
    throw new Error(
      'Push delivery resolves to fcm but GOOGLE_APPLICATION_CREDENTIALS is not set — keep PUSH_DELIVERY_PROVIDER unset (noop) until the FCM sender service account is mounted',
    );
  }
  const sender = new Adapter(configService);
  if (sender instanceof FcmPushSender) {
    await sender.init();
  }
  return sender;
}
