export interface OtpSession {
  countryCode: string;
  phoneNumber: string;
  otpHash: string;
  attempts: number;
  locked: boolean;
}

export abstract class OtpSessionStore {
  abstract set(
    sessionId: string,
    value: OtpSession,
    ttlSeconds: number,
  ): Promise<void>;

  abstract get(sessionId: string): Promise<OtpSession | null>;

  abstract delete(sessionId: string): Promise<void>;

  abstract increment(key: string, ttlSeconds: number): Promise<number>;
}
