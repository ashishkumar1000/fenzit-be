import { generateKeyPairSync, createVerify } from 'crypto';
import {
  compareVersionNames,
  PlayConsoleVersionService,
  PlayUnavailableError,
  versionFromCode,
} from './play-console-version.service';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const PKG = 'com.fenzit';
const EDITS = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/edits`;

// A real key pair, so the test can verify the JWT the service signs.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'release-bot@fenzit-play.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: TOKEN_URI,
});

/** The request URL as a string, whatever form fetch was given. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('versionFromCode / compareVersionNames', () => {
  it.each([
    [10403, '1.4.3'],
    [10402, '1.4.2'],
    [10099, '1.0.99'], // patch can reach 99 before minor moves
    [10100, '1.1.0'], // boundary: patch rolls into minor
    [20000, '2.0.0'],
  ])('versionCode %i is %s (build.gradle formula)', (code, name) => {
    expect(versionFromCode(code)).toBe(name);
  });

  it('compares numerically, so 1.10.0 is newer than 1.9.0', () => {
    expect(compareVersionNames('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });

  it('treats a missing segment as zero (1.4 == 1.4.0)', () => {
    expect(compareVersionNames('1.4', '1.4.0')).toBe(0);
  });

  it('orders a patch bump correctly in both directions', () => {
    expect(compareVersionNames('1.4.3', '1.4.2')).toBeGreaterThan(0);
    expect(compareVersionNames('1.4.2', '1.4.3')).toBeLessThan(0);
  });
});

describe('PlayConsoleVersionService', () => {
  let service: PlayConsoleVersionService;
  let fetchMock: jest.SpyInstance;
  const originalEnv = process.env['PLAY_SERVICE_ACCOUNT_JSON'];

  beforeEach(() => {
    process.env['PLAY_SERVICE_ACCOUNT_JSON'] = SERVICE_ACCOUNT;
    service = new PlayConsoleVersionService();
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    jest.useRealTimers();
    if (originalEnv === undefined)
      delete process.env['PLAY_SERVICE_ACCOUNT_JSON'];
    else process.env['PLAY_SERVICE_ACCOUNT_JSON'] = originalEnv;
  });

  /** The recorded fetch calls, with the URL as a string and typed init. */
  function calls(): Array<[string, RequestInit | undefined]> {
    return (
      fetchMock.mock.calls as unknown as Array<
        [RequestInfo | URL, RequestInit?]
      >
    ).map(([url, init]) => [urlOf(url), init]);
  }

  /** Routes the three Play calls: token exchange, edit create/delete, track read. */
  function playAnswers(track: unknown, trackStatus = 200) {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url === TOKEN_URI)
          return Promise.resolve(json({ access_token: 'tok-123' }));
        if (url === EDITS && init?.method === 'POST')
          return Promise.resolve(json({ id: 'edit-9' }));
        if (url === `${EDITS}/edit-9/tracks/production`) {
          return Promise.resolve(json(track, trackStatus));
        }
        if (url === `${EDITS}/edit-9` && init?.method === 'DELETE') {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.reject(new Error(`unexpected call ${url}`));
      },
    );
  }

  it('returns the newest fully rolled-out production version', async () => {
    playAnswers({
      releases: [
        { status: 'completed', versionCodes: ['10401', '10402'] },
        { status: 'completed', versionCodes: ['10400'] },
      ],
    });

    await expect(service.latestLiveAndroidVersion()).resolves.toBe('1.4.2');
  });

  it('ignores a release that is still in a staged rollout', async () => {
    playAnswers({
      releases: [
        { status: 'completed', versionCodes: ['10402'] },
        { status: 'inProgress', versionCodes: ['10403'] },
      ],
    });

    await expect(service.latestLiveAndroidVersion()).resolves.toBe('1.4.2');
  });

  it('refuses when there is no fully rolled-out release at all', async () => {
    playAnswers({
      releases: [{ status: 'inProgress', versionCodes: ['10403'] }],
    });

    await expect(service.latestLiveAndroidVersion()).rejects.toBeInstanceOf(
      PlayUnavailableError,
    );
  });

  it('signs a JWT with the service account: right issuer, scope and audience, and a valid signature', async () => {
    playAnswers({
      releases: [{ status: 'completed', versionCodes: ['10403'] }],
    });

    await service.latestLiveAndroidVersion();

    const tokenCall = calls().find(([url]) => url === TOKEN_URI);
    const form = new URLSearchParams(tokenCall?.[1]?.body as URLSearchParams);
    expect(form.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    const [header, claims, signature] = (form.get('assertion') ?? '').split(
      '.',
    );
    const claimsJson = JSON.parse(
      Buffer.from(claims, 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(claimsJson).toEqual(
      expect.objectContaining({
        iss: 'release-bot@fenzit-play.iam.gserviceaccount.com',
        scope: 'https://www.googleapis.com/auth/androidpublisher',
        aud: TOKEN_URI,
      }),
    );
    expect(claimsJson['exp']).toBeGreaterThan(claimsJson['iat'] as number);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, signature, 'base64url')).toBe(true);
  });

  it('uses the Play token on the track read and deletes the read-only edit', async () => {
    playAnswers({
      releases: [{ status: 'completed', versionCodes: ['10403'] }],
    });

    await service.latestLiveAndroidVersion();

    const trackCall = calls().find(([url]) =>
      url.endsWith('/tracks/production'),
    );
    expect(trackCall?.[1]?.headers).toEqual({
      authorization: 'Bearer tok-123',
    });
    expect(
      calls().some(
        ([url, init]) => url === `${EDITS}/edit-9` && init?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('still deletes the edit when the track read fails, and reports unavailable', async () => {
    playAnswers({ error: 'forbidden' }, 403);

    await expect(service.latestLiveAndroidVersion()).rejects.toBeInstanceOf(
      PlayUnavailableError,
    );
    expect(
      calls().some(
        ([url, init]) => url === `${EDITS}/edit-9` && init?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('reports unavailable when the service account env var is missing, without calling Google', async () => {
    delete process.env['PLAY_SERVICE_ACCOUNT_JSON'];

    await expect(service.latestLiveAndroidVersion()).rejects.toBeInstanceOf(
      PlayUnavailableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports unavailable for a malformed key, and never echoes the key in the message', async () => {
    process.env['PLAY_SERVICE_ACCOUNT_JSON'] =
      '{"client_email":"x","private_key":"SECRET-KEY-MATERIAL"}';

    const error: unknown = await service
      .latestLiveAndroidVersion()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlayUnavailableError);
    expect((error as Error).message).not.toContain('SECRET-KEY-MATERIAL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports unavailable when Google does not answer (network failure)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(service.latestLiveAndroidVersion()).rejects.toBeInstanceOf(
      PlayUnavailableError,
    );
  });

  it('asks for a one-hour token, the longest Google accepts', async () => {
    playAnswers({
      releases: [{ status: 'completed', versionCodes: ['10403'] }],
    });

    await service.latestLiveAndroidVersion();

    const tokenCall = calls().find(([url]) => url === TOKEN_URI);
    const form = new URLSearchParams(tokenCall?.[1]?.body as URLSearchParams);
    const claims = JSON.parse(
      Buffer.from(
        (form.get('assertion') ?? '').split('.')[1],
        'base64url',
      ).toString(),
    ) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it('still returns the version when the cleanup DELETE fails', async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url === TOKEN_URI)
          return Promise.resolve(json({ access_token: 'tok' }));
        if (url === EDITS && init?.method === 'POST')
          return Promise.resolve(json({ id: 'e1' }));
        if (url === `${EDITS}/e1/tracks/production`) {
          return Promise.resolve(
            json({
              releases: [{ status: 'completed', versionCodes: ['10403'] }],
            }),
          );
        }
        return Promise.resolve(new Response('boom', { status: 500 }));
      },
    );

    await expect(service.latestLiveAndroidVersion()).resolves.toBe('1.4.3');
  });

  it('reports unavailable when Google sends a non-JSON body with 200', async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url === TOKEN_URI)
          return Promise.resolve(json({ access_token: 'tok' }));
        if (url === EDITS && init?.method === 'POST') {
          return Promise.resolve(
            new Response('<html>captive portal</html>', { status: 200 }),
          );
        }
        return Promise.reject(new Error(`unexpected call ${url}`));
      },
    );

    await expect(service.latestLiveAndroidVersion()).rejects.toBeInstanceOf(
      PlayUnavailableError,
    );
  });

  it('reports unavailable, not a raw crypto error, when the private key cannot sign', async () => {
    process.env['PLAY_SERVICE_ACCOUNT_JSON'] = JSON.stringify({
      client_email: 'x@y.iam.gserviceaccount.com',
      private_key: 'not-a-pem-key',
      token_uri: TOKEN_URI,
    });

    await expect(service.latestLiveAndroidVersion()).rejects.toBeInstanceOf(
      PlayUnavailableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores version codes that are not plain digits, such as 1e9', async () => {
    playAnswers({
      releases: [{ status: 'completed', versionCodes: ['1e9', '10402'] }],
    });

    await expect(service.latestLiveAndroidVersion()).resolves.toBe('1.4.2');
  });

  it('caches the answer for 5 minutes, then asks Google again', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-13T06:00:00Z') });
    playAnswers({
      releases: [{ status: 'completed', versionCodes: ['10403'] }],
    });

    await service.latestLiveAndroidVersion();
    const callsAfterFirst = calls().length;
    await service.latestLiveAndroidVersion();
    expect(calls().length).toBe(callsAfterFirst);

    jest.setSystemTime(new Date('2026-11-13T06:06:00Z'));
    await service.latestLiveAndroidVersion();
    expect(calls().length).toBeGreaterThan(callsAfterFirst);
  });
});
