/**
 * The per-phone cap on invite SMS (spec-invite-sms-download-link CAP-2, story
 * 21-2). Every invite and re-invite counts, and so does every resend. At most
 * this many counted sends may reach one phone number in the rolling window.
 * Changing either value needs a new owner decision.
 */
export const INVITE_SMS_CAP_PER_PHONE = 5;
export const INVITE_SMS_CAP_WINDOW_MINUTES = 60;
