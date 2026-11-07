import type { Message } from 'firebase-admin/messaging';
import {
  PushSender,
  PushSendError,
  PushSendOutcome,
  PushMessage,
} from './push-sender.port';

/**
 * The firebase-admin adapter (CAP-2, stack.md Phase 3). Credentials come
 * from GOOGLE_APPLICATION_CREDENTIALS via `applicationDefault()` — the
 * dedicated `fenzit-fcm-sender` service account (role: Firebase Cloud
 * Messaging API Admin); the JSON is never in git or inside any repo
 * directory, and the project id comes from the credential itself.
 *
 * firebase-admin is imported LAZILY (dynamic import on init, not module
 * top): under NODE_ENV=test the provider registry resolves noop, so the
 * heavy SDK never loads in a jest process at all, and under Bun no native
 * module is probed until the fcm flip is actually configured.
 *
 * Runtime note (stack.md): fenzit-be ships on Bun, where the SDK's gRPC
 * transport is not usable — sends should ride the SDK's legacy HTTP/1.1
 * transport (`enableLegacyHttpTransport()`, v14's name for the older
 * `useHttp1Transport()`). The call is guarded by a feature check so a
 * future SDK rename degrades to the default transport instead of crashing
 * the boot.
 */

/** The FCM token is dead — delete the device_tokens row (frozen matrix). */
const TOKEN_NOT_REGISTERED = 'messaging/registration-token-not-registered';
/** The FCM token is invalid for this sender — same fate. */
const TOKEN_INVALID = 'messaging/invalid-registration-token';

/** 429/503 families — the only errors the sweep retries (frozen matrix). */
const RETRYABLE_CODES = new Set([
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'messaging/quota-exceeded',
  'messaging/server-unavailable',
]);

/** Minimal shape of the legacy-transport toggle, for the guarded call. */
type LegacyTransportMessaging = {
  enableLegacyHttpTransport?: () => void;
};

/** Structural view of admin's Messaging — keeps the SDK type-only here. */
interface MessagingLike {
  sendEach(messages: Message[]): Promise<{
    responses: { success: boolean; error?: unknown }[];
  }>;
}

export class FcmPushSender extends PushSender {
  private messaging: MessagingLike | null = null;
  private initializing: Promise<MessagingLike> | null = null;

  // Deliberately constructor-less (the MockSmsDeliveryProvider precedent):
  // the registry constructs every adapter with ConfigService, and a 0-arg
  // constructor slots into that shape without pretending to need it.

  /**
   * Loads the SDK and binds Messaging once, at provider-factory time — a
   * broken credential must fail the BOOT, not the first notification
   * (the SMS msg91 boot-error principle).
   */
  async init(): Promise<void> {
    await this.ensureMessaging();
  }

  async sendEach(messages: PushMessage[]): Promise<PushSendOutcome[]> {
    const messaging = await this.ensureMessaging();
    // Caller caps at 500 (FCM's sendEach limit) so responses stay
    // order-mapped to the input.
    const batch = await messaging.sendEach(messages.map(toFcmMessage));
    return batch.responses.map((response, i) => ({
      message: messages[i],
      error: response.success ? null : this.toSendError(response.error),
    }));
  }

  private async ensureMessaging(): Promise<MessagingLike> {
    if (this.messaging) {
      return this.messaging;
    }
    if (!this.initializing) {
      this.initializing = this.initMessaging().then((messaging) => {
        this.messaging = messaging;
        return messaging;
      });
    }
    return this.initializing;
  }

  private async initMessaging(): Promise<MessagingLike> {
    const appModule = await import('firebase-admin/app');
    const messagingModule = await import('firebase-admin/messaging');
    const app =
      appModule.getApps().length > 0
        ? appModule.getApp()
        : appModule.initializeApp({
            // ADC reads GOOGLE_APPLICATION_CREDENTIALS (env/file mount).
            credential: appModule.applicationDefault(),
          });
    const messaging = messagingModule.getMessaging(app) as MessagingLike &
      LegacyTransportMessaging;
    if (typeof messaging.enableLegacyHttpTransport === 'function') {
      // Bun has no gRPC: every send rides HTTP/1.1 (stack.md transport note).
      messaging.enableLegacyHttpTransport();
    }
    return messaging;
  }

  /** Map one FCM failure to the port's action kinds (see PushSendError). */
  private toSendError(error: unknown): PushSendError {
    const code = readString(error, 'code') ?? 'messaging/unknown-error';
    const detail = readString(error, 'message') ?? 'no detail';
    if (code === TOKEN_NOT_REGISTERED) {
      return { kind: 'unregistered', code, detail };
    }
    if (code === TOKEN_INVALID) {
      return { kind: 'invalid', code, detail };
    }
    if (code === 'messaging/invalid-argument') {
      // invalid-argument is only a DEAD TOKEN when the token itself is the
      // bad argument; otherwise it indicts OUR payload and every token in
      // the batch would be wrongly deleted (the app re-registers, but that
      // is churn the sweep must not cause).
      return /registration token/i.test(detail)
        ? { kind: 'invalid', code, detail }
        : { kind: 'permanent', code, detail };
    }
    return {
      kind: RETRYABLE_CODES.has(code) ? 'retryable' : 'permanent',
      code,
      detail,
    };
  }
}

/**
 * Port message → FCM v1 wire shape. Still the hybrid notification + data
 * message (never data-only): the top-level `notification` stays, and the
 * UX deltas ride Android notification OPTIONS — the channel id (EXPERIENCE.md's
 * four channels) and the lock-screen visibility — which FCM applies to the
 * displayed notification without changing its hybrid nature. No other raw
 * android/apns config (stack.md).
 */
function toFcmMessage(message: PushMessage): Message {
  return {
    token: message.token,
    notification: {
      title: message.title,
      // FCM rejects an empty body string — send title-only when the copy
      // layer had no honest body (e.g. drifted summary payloads).
      ...(message.body.length > 0 ? { body: message.body } : {}),
    },
    data: message.data,
    ...(message.channel || message.visibility
      ? {
          android: {
            notification: {
              ...(message.channel ? { channelId: message.channel } : {}),
              ...(message.visibility
                ? {
                    // The SDK spells visibility lowercase; the copy layer
                    // speaks the UX table's uppercase vocabulary.
                    visibility: message.visibility.toLowerCase() as
                      'public' | 'private',
                  }
                : {}),
            },
          },
        }
      : {}),
  };
}

function readString(source: unknown, key: string): string | null {
  const value = (source as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
