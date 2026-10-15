/**
 * The SMS channel port (PRD prd-otp-sms-msg91-2026-09-18 §11 AD-1): named and
 * shaped per CHANNEL, never per message type. OTP login, technician invites,
 * job updates are message types that all travel over this one port, each with
 * its own DLT-approved template ID. Every DLT SMS is an approved template +
 * variable values — that is the channel's message model, so the signature is
 * frozen at exactly that; adapters vary behind it, and a message type needing
 * more than the template model one day is a NEW port, not a change to this.
 */
export abstract class SmsDeliveryProvider {
  /** Send a DLT-approved template message. `variables` maps the template's
   *  `##name##` slots by NAME (DLT variables are named, not positional —
   *  e.g. the OTP template's `##number##` → `{ number: '1234' }`); DLT caps
   *  at 3 non-consecutive variables per template. */
  abstract send(
    to: string,
    templateId: string,
    variables: Record<string, string>,
  ): Promise<void>;
}

/**
 * Provider-agnostic delivery failure (§11 AD-4): thrown by adapters at the
 * port boundary so vendor error shapes never leak into services. `outcome`
 * carries the one distinction the service must act on — `timeout` means the
 * request MIGHT have been dispatched (the SMS can still arrive; the caller
 * must keep the just-created session), `error` means it definitively was not
 * (the caller can delete the session). `vendorType` is MSG91's response
 * `type` field, for the delivery log only.
 */
export class SmsDeliveryError extends Error {
  constructor(
    message: string,
    readonly outcome: 'timeout' | 'error',
    readonly vendorType?: string,
  ) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}
