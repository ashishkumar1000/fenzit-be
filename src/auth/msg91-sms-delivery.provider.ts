import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import {
  SmsDeliveryProvider,
  SmsDeliveryError,
} from './sms-delivery.provider';

/**
 * The v5 FLOW endpoint — NOT the v5 /otp endpoint. Live-verified 2026-10-15:
 * /otp accepts its `otp` query param (returns type:success, request_id) but
 * the message then FAILS DLT scrubbing for a template whose variable is
 * named anything but `##OTP##` — our approved template's slot is
 * `##number##`, so nothing ever delivered. The flow endpoint maps variable
 * values BY NAME, which is what DLT templates actually need.
 */
const MSG91_FLOW_ENDPOINT = 'https://control.msg91.com/api/v5/flow/';
const REQUEST_TIMEOUT_MS = 4000;

/**
 * MSG91 adapter for the SMS channel port (PRD FR-BE1, §11 AD-2). MSG91
 * renders the DLT template server-side from `templateId` — the approved
 * copy lives in their panel, not here; this adapter only carries the
 * template ID and the named variable values. IDs live in
 * src/common/constants/sms-templates.ts (code constants — only the auth
 * key is env config).
 */
@Injectable()
export class Msg91SmsDeliveryProvider extends SmsDeliveryProvider {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  async send(
    to: string,
    templateId: string,
    variables: Record<string, string>,
  ): Promise<void> {
    // E.164 ("+919876543210") → MSG91's mobiles format ("919876543210"):
    // country code prefixed, no '+', digits only.
    const mobile = to.replace(/\D/g, '');

    let response: Response;
    try {
      response = await fetch(MSG91_FLOW_ENDPOINT, {
        method: 'POST',
        // authkey rides the HEADER — header transport keeps the secret
        // out of URLs and access logs.
        headers: {
          authkey: this.configService.getOrThrow<string>('MSG91_AUTH_KEY'),
          accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_id: templateId,
          // No URLs in our templates — keep the shortener explicitly off.
          short_url: 0,
          recipients: [{ mobiles: mobile, ...variables }],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // AbortSignal.timeout rejects with TimeoutError (named so since Node
      // 17.3; some runtimes surface a generic AbortError). A timeout means
      // the request MAY have been dispatched — MSG91 can still deliver the
      // SMS — so it must not be folded into the plain-error outcome.
      const timedOut =
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (timedOut) {
        throw new SmsDeliveryError(
          `MSG91 send timed out after ${REQUEST_TIMEOUT_MS}ms`,
          'timeout',
        );
      }
      throw new SmsDeliveryError(
        `MSG91 send failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }

    // Success predicate: HTTP 2xx AND body {"type":"success"}. MSG91 can
    // answer 200 with a {"type":"error"} body (DLT/template rejections do
    // this), so the body must be checked, not just the status.
    interface Msg91Response {
      type?: string;
      message?: unknown;
    }
    let body: Msg91Response | null = null;
    try {
      body = (await response.json()) as Msg91Response;
    } catch (err) {
      // A timeout during the BODY read is not a definitive failure — the
      // response headers arrived, so MSG91 accepted the request and the SMS
      // may still dispatch. Same outcome split as the fetch phase above;
      // only a genuinely non-JSON body falls through as type 'none'.
      if (
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      ) {
        throw new SmsDeliveryError(
          `MSG91 response read timed out after ${REQUEST_TIMEOUT_MS}ms`,
          'timeout',
        );
      }
    }
    if (!response.ok || body?.type !== 'success') {
      const detail =
        body?.message !== undefined ? `: ${String(body.message)}` : '';
      throw new SmsDeliveryError(
        `MSG91 send rejected (HTTP ${response.status}, type ${body?.type ?? 'none'})${detail}`,
        'error',
        body?.type,
      );
    }
  }
}
