/**
 * The push channel port (the SMS port's sibling): named and shaped per
 * CHANNEL (deliver one user-facing push per device token), never per message
 * type — the message's title/body/data are already composed by the caller
 * (the sweep, from push-copy.ts). Adapters vary behind it (noop today, fcm
 * tomorrow, apns-direct never — FCM covers both platforms).
 *
 * Message contract (stack.md): always the hybrid `notification` {title, body}
 * + small `data` map — never data-only — so background/quit devices display
 * the OS notification with no JS running, and the tap deep-links off `data`.
 */

/** One outbound push for one device token. */
export interface PushMessage {
  /** The recipient device's FCM registration token. */
  token: string;
  /** OS notification title — never empty (the copy layer guarantees it). */
  title: string;
  /** OS notification body; empty means "send the notification title only". */
  body: string;
  /**
   * Flat string map per the frozen contract: `{ type: <event_type>,
   * id?: <job_id ?? entity_id> }` — keys forbidden by FCM (`from`, `gcm`,
   * `google*`) must never appear here.
   */
  data: Record<string, string>;
  /**
   * Android channel id (EXPERIENCE.md's four-channel table); omitted for
   * unknown types so the device default `fenzit_default` applies.
   */
  channel?: string;
  /** Android lock-screen visibility; omitted when the UX table names none. */
  visibility?: 'PUBLIC' | 'PRIVATE';
}

/**
 * Why one send failed, reduced to the ONE distinction the caller must act
 * on: `unregistered`/`invalid` mean the token is dead (delete the row),
 * `retryable` means FCM said come back (429/503), `permanent` means this
 * attempt failed but the token may be fine (record + log). Vendor error
 * shapes never leak past this port.
 */
export type PushSendFailureKind =
  'unregistered' | 'invalid' | 'retryable' | 'permanent';

export interface PushSendError {
  kind: PushSendFailureKind;
  /** The provider's stable error code (e.g. `messaging/server-unavailable`)
   *  — stored on device_tokens.last_failure for diagnostics. */
  code: string;
  /** Human detail for the log line. */
  detail: string;
}

/** Per-message outcome of one send batch — ORDER-MAPPED to the input. */
export interface PushSendOutcome {
  /** The message this outcome refers to (carries the failing token). */
  message: PushMessage;
  /** null = handed off to FCM successfully. */
  error: PushSendError | null;
}

export abstract class PushSender {
  /**
   * Send each message to its own token; the caller caps the batch at
   * FCM's 500 so responses stay order-mapped. Never throws for per-message
   * failures — those come back as outcomes; only transport-level blowups
   * (auth, network) may throw, and the sweep logs and drops them.
   */
  abstract sendEach(messages: PushMessage[]): Promise<PushSendOutcome[]>;
}
