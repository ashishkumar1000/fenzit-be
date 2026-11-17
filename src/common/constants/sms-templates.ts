/**
 * DLT-approved SMS template IDs (PRD prd-otp-sms-msg91-2026-09-18 §10).
 *
 * These are CODE constants, not deploy config: a template ID is frozen to
 * its approved copy (DLT templates cannot be edited after approval), and no
 * ID is a secret. The only SMS credential that lives in env is
 * MSG91_AUTH_KEY.
 *
 * ⚠️ The IDs here are MSG91 PANEL template IDs — the string MSG91's send
 * API accepts — NOT the DLT registry IDs (the two differ; PRD §8 step 5).
 *
 * Each entry's comment pins the exact approved copy: when a template's
 * wording ever changes, it is re-registered as a NEW template and gets a
 * NEW ID — update the ID and the copy here together, never one alone.
 */
/**
 * Placeholder until the owner supplies the approved DLT template ID for the
 * invite SMS. While the T-INVITE value equals this, invite SMS sending is OFF
 * and every invite returns sms_status `not_configured`. Never ship a real
 * send with this value. No approved template carries this value today
 * (T-INVITE was filled on 2026-11-17), but the gate stays for any future
 * template that lands before its ID does.
 */
export const INVITE_TEMPLATE_PLACEHOLDER = 'PENDING_DLT_APPROVAL';

/**
 * The one download URL the invite SMS names. The DLT copy was approved with
 * a `##url##` variable, and DLT scrubbing rejects other URLs — so the value
 * is fixed here and every send passes exactly this string.
 */
export const INVITE_SMS_DOWNLOAD_URL = 'https://fenzit.com/app/download';

export const SMS_TEMPLATES = {
  /**
   * T-INVITE — invite SMS with the download link (spec-invite-sms-download-link,
   * story 21-1). Approved copy as registered (DLT ID supplied 2026-11-17):
   *   `Hi ##employee##, you have been added to ##company## as an Employee. Get the app at ##url## and login with this number - Fenzit Technology`
   * Variables are named: `##employee##` (fitFirstName), `##company##`
   * (fitCompanyName), `##url##` (always INVITE_SMS_DOWNLOAD_URL).
   * There is no role variable — every role, admin and viewer included,
   * reads "as an Employee" (owner decision 2026-11-17). With the longest
   * variables (12-char name, 20-char company) the message renders at 170
   * characters, i.e. a 2-part SMS; typical values stay within one part.
   */
  'T-INVITE': '6afb418448cacda45c094b32',
  /**
   * T1 — OTP login (all users). Sender ID FENZIT; DLT registry template ID
   * 1277179042535914512. Approved copy (rendered server-side by MSG91 from
   * the `##number##` variable):
   *   `Your FENZIT Login OTP is ##number##. Valid for 5 minutes. Do not
   *    share this OTP to anyone - Fenzit Technology.`
   * The "Valid for 5 minutes" wording freezes OTP_TTL_SECONDS at 300
   * (auth.service.ts) — changing the TTL means re-registering the template.
   */
  OTP_LOGIN: '6abbb9d03a3773ee7209dd94',
} as const;

export type SmsTemplateName = keyof typeof SMS_TEMPLATES;
