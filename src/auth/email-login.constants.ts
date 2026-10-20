// DEV SHORTCUT — remove at go-live gate
//
// The fixed password for POST /auth/email/login. It is HARDCODED here on
// purpose (product owner's call, 2026-10-20; web-login-and-owner-admin-spec
// decision 8, roles-and-access-spec decisions 9 and 30): never read it from an
// environment variable, never put it in a VITE_* value, never log or return it.
//
// Same family as PRE_RELEASE_MASTER_OTP (1039) in auth.service.ts. REMOVE AT
// GO-LIVE: delete this file, EmailLoginService, its DTO, the controller route
// and the module provider. Unlike the master OTP this is NOT behind an env
// flag, so forgetting it leaves a live backdoor — the go-live gate blocks the
// release until it is gone.
export const DEV_SHORTCUT_EMAIL_PASSWORD = 'yah00Mail';

/** Wrong-password attempts allowed per email inside the window (mirrors the OTP 5-attempt lockout). */
export const EMAIL_LOGIN_MAX_FAILURES = 5;
/** Lockout window in seconds (mirrors the 10-minute OTP send window). */
export const EMAIL_LOGIN_WINDOW_SECONDS = 600;
