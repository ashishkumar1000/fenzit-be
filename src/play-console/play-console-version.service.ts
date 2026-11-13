import { createSign } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';

/** Package id of the Android app on Google Play. */
export const PLAY_PACKAGE_NAME = 'com.fenzit';

const PLAY_API =
  'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

/** Google Play could not give a trustworthy answer. Callers must refuse, not guess. */
export class PlayUnavailableError extends Error {}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

interface PlayTrack {
  releases?: Array<{ status?: string; versionCodes?: string[] }>;
}

/**
 * Version code → version name, per android/app/build.gradle:
 * versionCode = 10000*major + 100*minor + patch (1.4.3 → 10403).
 */
export function versionFromCode(code: number): string {
  const major = Math.floor(code / 10000);
  const minor = Math.floor((code % 10000) / 100);
  const patch = code % 100;
  return `${major}.${minor}.${patch}`;
}

/** Numeric compare of dot segments: > 0 if `a` is newer, < 0 if `b` is, 0 if equal. */
export function compareVersionNames(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((p) => parseInt(p, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString('base64url');

/**
 * Reads the Android version live on Google Play (production track) with the
 * official Play Developer API, using the service account already used by the
 * release pipeline (PLAY_SERVICE_ACCOUNT_JSON). Read-only: an edit is opened to
 * read the track and then deleted; nothing is published.
 *
 * Only releases with status "completed" count (full rollout). A version still
 * in a staged rollout is not what users are told is live. Answers are cached
 * for a few minutes so saves do not depend on Play on every request.
 */
@Injectable()
export class PlayConsoleVersionService {
  private readonly logger = new Logger(PlayConsoleVersionService.name);
  private cache: { version: string; fetchedAtMs: number } | null = null;

  async latestLiveAndroidVersion(): Promise<string> {
    if (this.cache && Date.now() - this.cache.fetchedAtMs < CACHE_TTL_MS) {
      return this.cache.version;
    }
    const token = await this.accessToken();
    const version = await this.readProductionVersion(token);
    this.cache = { version, fetchedAtMs: Date.now() };
    return version;
  }

  private loadServiceAccount(): ServiceAccount {
    const raw = process.env['PLAY_SERVICE_ACCOUNT_JSON'];
    if (!raw) {
      throw new PlayUnavailableError('PLAY_SERVICE_ACCOUNT_JSON is not set');
    }
    try {
      const sa = JSON.parse(raw) as Partial<ServiceAccount>;
      if (!sa.client_email || !sa.private_key || !sa.token_uri) {
        throw new Error('missing field');
      }
      return sa as ServiceAccount;
    } catch {
      // Never include the key material in the error or the log.
      throw new PlayUnavailableError('PLAY_SERVICE_ACCOUNT_JSON is not valid');
    }
  }

  /** Signs a JWT with the service account key and trades it for an access token. */
  private async accessToken(): Promise<string> {
    const sa = this.loadServiceAccount();
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: PLAY_SCOPE,
        aud: sa.token_uri,
        iat: now,
        exp: now + 3600,
      }),
    )}`;
    let signature: string;
    try {
      signature = createSign('RSA-SHA256')
        .update(unsigned)
        .sign(sa.private_key, 'base64url');
    } catch {
      // A malformed key must not surface as a raw crypto error.
      throw new PlayUnavailableError(
        'PLAY_SERVICE_ACCOUNT_JSON key cannot sign',
      );
    }

    const body = await this.request<{ access_token?: string }>(sa.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!body.access_token) {
      throw new PlayUnavailableError('Google sign-in returned no access token');
    }
    return body.access_token;
  }

  private async readProductionVersion(token: string): Promise<string> {
    const auth = { authorization: `Bearer ${token}` };
    const base = `${PLAY_API}/${PLAY_PACKAGE_NAME}/edits`;
    const edit = await this.request<{ id?: string }>(base, {
      method: 'POST',
      headers: auth,
    });
    if (!edit.id) {
      throw new PlayUnavailableError('Play returned no edit id');
    }
    try {
      const track = await this.request<PlayTrack>(
        `${base}/${edit.id}/tracks/production`,
        { headers: auth },
      );
      const codes = (track.releases ?? [])
        .filter((r) => r.status === 'completed')
        // Only plain digits count: "1e9" or "" must not overstate the live version.
        .flatMap((r) =>
          (r.versionCodes ?? []).filter((c) => /^\d+$/.test(c)).map(Number),
        )
        .filter((n) => Number.isSafeInteger(n) && n > 0);
      if (codes.length === 0) {
        throw new PlayUnavailableError(
          'No fully rolled-out production release on Google Play',
        );
      }
      return versionFromCode(Math.max(...codes));
    } finally {
      // Discard the read-only edit. A failure here does not change the answer.
      await this.request(`${base}/${edit.id}`, {
        method: 'DELETE',
        headers: auth,
      }).catch(() => undefined);
    }
  }

  /** One HTTP call with a timeout. Any failure becomes PlayUnavailableError. */
  private async request<T = unknown>(
    url: string,
    init: RequestInit,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      this.logger.warn(`Google Play call failed: ${(cause as Error).name}`);
      throw new PlayUnavailableError('Google Play did not answer in time');
    }
    if (!res.ok) {
      // Status only: the body can echo request details, so it is not logged.
      this.logger.warn(`Google Play call returned HTTP ${res.status}`);
      throw new PlayUnavailableError(`Google Play returned HTTP ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      // e.g. a captive-portal HTML page answered with 200.
      throw new PlayUnavailableError(
        'Google Play returned a body that is not JSON',
      );
    }
  }
}
