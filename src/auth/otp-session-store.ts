export interface OtpSession {
  countryCode: string;
  phoneNumber: string;
  otpHash: string;
  attempts: number;
  locked: boolean;
  /**
   * Absolute session expiry (epoch ms). A failed-attempt write must hold
   * the REMAINING ttl against this, not a fresh window — otherwise paced
   * wrong guesses extend the session past its advertised expires_at
   * (bug-bash 2026-10-02 review, EC-1).
   */
  expiresAt: number;
}

export interface OtpRateLimitIncrementResult {
  count: number;
  /** Seconds left in the CURRENT window (ceil, minimum 1) — what a tripped 429 should report as Retry-After. Mirrors the places rate-limit store's contract. */
  windowRemainingSeconds: number;
}

export abstract class OtpSessionStore {
  abstract set(
    sessionId: string,
    value: OtpSession,
    ttlSeconds: number,
  ): Promise<void>;

  abstract get(sessionId: string): Promise<OtpSession | null>;

  abstract delete(sessionId: string): Promise<void>;

  abstract increment(
    key: string,
    ttlSeconds: number,
  ): Promise<OtpRateLimitIncrementResult>;
}
