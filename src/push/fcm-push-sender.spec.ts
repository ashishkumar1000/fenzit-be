import type { PushMessage } from './push-sender.port';
import { FcmPushSender } from './fcm-push-sender';

const mockSendEach = jest.fn();
const mockEnableLegacy = jest.fn();
const mockGetMessaging = jest.fn();
const mockInitializeApp = jest.fn();
const mockGetApps = jest.fn();
const mockGetApp = jest.fn();

jest.mock('firebase-admin/app', () => ({
  getApps: () => mockGetApps(),
  getApp: () => mockGetApp(),
  initializeApp: (opts: unknown) => mockInitializeApp(opts),
  applicationDefault: () => ({ kind: 'adc' }),
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: (app: unknown) => mockGetMessaging(app),
}));

const message = (over: Partial<PushMessage> = {}): PushMessage => ({
  token: 'tok-1',
  title: 'New job assigned',
  body: 'JB-2026-0002 · Asha',
  data: { type: 'job.assigned', id: 'job-1' },
  ...over,
});

/** One FCM response per message, in the order sent. */
function fcmResponses(errors: (object | null)[]) {
  return {
    responses: errors.map((error) =>
      error === null ? { success: true } : { success: false, error },
    ),
  };
}

const fcmError = (code: string, message = 'details') => ({ code, message });

/**
 * The SDK is loaded by a dynamic import, which jest cannot run without VM
 * modules. The sender caches its client after the first load, so the tests
 * inject that cached client directly. Real credential loading is covered by
 * the live FCM sweep run against the dev project (not by this spec).
 */
function senderWithMessaging(): FcmPushSender {
  const sender = new FcmPushSender();
  (sender as unknown as { messaging: unknown }).messaging = {
    sendEach: mockSendEach,
    enableLegacyHttpTransport: mockEnableLegacy,
  };
  return sender;
}

describe('FcmPushSender', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetApps.mockReturnValue([]);
    mockInitializeApp.mockReturnValue({ name: 'app' });
    mockGetApp.mockReturnValue({ name: 'existing' });
    mockGetMessaging.mockReturnValue({
      sendEach: mockSendEach,
      enableLegacyHttpTransport: mockEnableLegacy,
    });
  });

  describe('error classification', () => {
    async function classify(error: object) {
      mockSendEach.mockResolvedValueOnce(fcmResponses([error]));
      const [outcome] = await senderWithMessaging().sendEach([message()]);
      return outcome.error;
    }

    it('a not-registered token is unregistered (the row is deleted)', async () => {
      expect(
        await classify(fcmError('messaging/registration-token-not-registered')),
      ).toMatchObject({ kind: 'unregistered' });
    });

    it('an invalid registration token is invalid (the row is deleted)', async () => {
      expect(
        await classify(fcmError('messaging/invalid-registration-token')),
      ).toMatchObject({ kind: 'invalid' });
    });

    it('invalid-argument that names the token is a dead token', async () => {
      expect(
        await classify(
          fcmError('messaging/invalid-argument', 'Invalid registration token provided'),
        ),
      ).toMatchObject({ kind: 'invalid' });
    });

    it('invalid-argument about OUR payload is permanent: tokens must not be deleted', async () => {
      // Deleting every token of a batch over a bad payload would churn every
      // user's device registration. This is the guard against that.
      expect(
        await classify(
          fcmError('messaging/invalid-argument', 'Invalid data payload key: from'),
        ),
      ).toMatchObject({ kind: 'permanent' });
    });

    it.each([
      'messaging/message-rate-exceeded',
      'messaging/device-message-rate-exceeded',
      'messaging/quota-exceeded',
      'messaging/server-unavailable',
    ])('%s is retryable', async (code) => {
      expect(await classify(fcmError(code))).toMatchObject({ kind: 'retryable' });
    });

    it('an internal error is permanent (not retried)', async () => {
      expect(
        await classify(fcmError('messaging/internal-error')),
      ).toMatchObject({ kind: 'permanent' });
    });

    it('an error with no code falls back to unknown-error, permanent', async () => {
      expect(await classify({ message: 'no code here' })).toEqual({
        kind: 'permanent',
        code: 'messaging/unknown-error',
        detail: 'no code here',
      });
    });

    it('an empty code string is treated as missing', async () => {
      expect(await classify({ code: '', message: 'x' })).toMatchObject({
        kind: 'permanent',
        code: 'messaging/unknown-error',
      });
    });
  });

  describe('outcome mapping', () => {
    it('keeps outcomes in the order of the input messages', async () => {
      mockSendEach.mockResolvedValueOnce(
        fcmResponses([null, fcmError('messaging/invalid-registration-token'), null]),
      );
      const input = [
        message({ token: 'a' }),
        message({ token: 'b' }),
        message({ token: 'c' }),
      ];
      const outcomes = await senderWithMessaging().sendEach(input);

      expect(outcomes.map((o) => o.message.token)).toEqual(['a', 'b', 'c']);
      expect(outcomes.map((o) => o.error?.kind ?? null)).toEqual([
        null,
        'invalid',
        null,
      ]);
    });

    it('an SDK transport failure propagates to the sweep to handle', async () => {
      mockSendEach.mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(senderWithMessaging().sendEach([message()])).rejects.toThrow(
        'ECONNRESET',
      );
    });
  });

  describe('wire shape', () => {
    async function sentWire(over: Partial<PushMessage>) {
      mockSendEach.mockResolvedValueOnce(fcmResponses([null]));
      await senderWithMessaging().sendEach([message(over)]);
      return mockSendEach.mock.calls[0][0][0];
    }

    it('sends a hybrid notification with the title and body', async () => {
      const wire = await sentWire({});
      expect(wire.notification).toEqual({
        title: 'New job assigned',
        body: 'JB-2026-0002 · Asha',
      });
      expect(wire.data).toEqual({ type: 'job.assigned', id: 'job-1' });
    });

    it('omits the body key entirely when the body is empty (FCM rejects "")', async () => {
      const wire = await sentWire({ body: '' });
      expect(wire.notification).toEqual({ title: 'New job assigned' });
      expect(wire.notification).not.toHaveProperty('body');
    });

    it('lowercases visibility and sets the channel in android options', async () => {
      const wire = await sentWire({
        channel: 'fenzit_jobs',
        visibility: 'PRIVATE',
      });
      expect(wire.android).toEqual({
        notification: {
          clickAction: 'com.fenzit.PUSH_TAP',
          channelId: 'fenzit_jobs',
          visibility: 'private',
        },
      });
    });

    it('always sends the tap click action, so a cold tap carries the push data to the app', async () => {
      // Without clickAction the app cannot tell which push was tapped when
      // it was closed (the launcher intent carries no data).
      const wire = await sentWire({});
      expect(wire.android).toEqual({
        notification: { clickAction: 'com.fenzit.PUSH_TAP' },
      });
    });
  });
});
