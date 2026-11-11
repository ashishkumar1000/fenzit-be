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
 * send with this value.
 */
export const INVITE_TEMPLATE_PLACEHOLDER = 'PENDING_DLT_APPROVAL';

export const SMS_TEMPLATES = {
  /**
   * T-INVITE — invite SMS with the download link (spec-invite-sms-download-link,
   * story 21-1). One template for all roles. DLT variables are named, so the
   * registered copy must use these exact names (`##name##`, `##company##`,
   * `##role##`):
   *   `Hi ##name##, you are added to ##company## as ##role##. Get the app at fenzit.com/app/download and log in with this number. - Fenzit Technology`
   * Still a placeholder: the approved MSG91 panel ID is not supplied yet.
   */
  'T-INVITE': INVITE_TEMPLATE_PLACEHOLDER,
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
