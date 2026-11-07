import type { PushMessage } from './push-sender.port';
import { PushSender, PushSendOutcome } from './push-sender.port';

/**
 * The default provider (PUSH_DELIVERY_PROVIDER unset/noop): every send is
 * "delivered" without touching a network, and the sweep never starts (it
 * checks for this adapter before arming its interval). Keeping the port
 * honest — not skipping it — means a provider flip is a one-env-var change
 * with no code path the fcm day has never exercised.
 */
export class NoopPushSender extends PushSender {
  // No await on purpose: the port is async so the fcm adapter can be
  // swapped in behind the same call shape.
  sendEach(messages: PushMessage[]): Promise<PushSendOutcome[]> {
    return Promise.resolve(
      messages.map((message) => ({ message, error: null })),
    );
  }
}
