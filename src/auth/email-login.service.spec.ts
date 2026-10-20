import {
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EmailLoginService } from './email-login.service';
import { EmailLoginDto } from './dto/email-login.dto';
import {
  DEV_SHORTCUT_EMAIL_PASSWORD,
  EMAIL_LOGIN_MAX_FAILURES,
} from './email-login.constants';

const USER = {
  id: 'u-1',
  country_code: '+91',
  phone_number: '9000000001',
  name: 'Asha',
  platform_admin: false,
  disabled: false,
};

function memoryCache() {
  const m = new Map<string, unknown>();
  return {
    get: jest.fn((k: string) => Promise.resolve(m.get(k))),
    set: jest.fn((k: string, v: unknown) => {
      m.set(k, v);
      return Promise.resolve();
    }),
    del: jest.fn((k: string) => {
      m.delete(k);
      return Promise.resolve();
    }),
  };
}

function build(row: unknown = USER, dbError: unknown = null) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: row, error: dbError }),
  };
  const admin = { from: jest.fn().mockReturnValue(query) };
  const factory = { createAdmin: jest.fn().mockReturnValue(admin) };
  const auth = {
    issueLogin: jest
      .fn()
      .mockResolvedValue({ token: 't', user: { userId: 'u-1' } }),
  };
  const cache = memoryCache();
  const svc = new EmailLoginService(
    auth as never,
    factory as never,
    cache as never,
  );
  return { svc, auth, query, cache };
}

const ok = (email = 'a@b.co') => ({
  email,
  password: DEV_SHORTCUT_EMAIL_PASSWORD,
});
const bad = (email = 'a@b.co', password = 'nope') => ({ email, password });

describe('EmailLoginService', () => {
  const originalEcho = process.env['OTP_DEV_ECHO'];
  beforeEach(() => {
    // The shortcut is a dev-only route, gated on the same flag as the master OTP.
    process.env['OTP_DEV_ECHO'] = 'true';
  });
  afterEach(() => {
    if (originalEcho === undefined) delete process.env['OTP_DEV_ECHO'];
    else process.env['OTP_DEV_ECHO'] = originalEcho;
  });

  it.each([undefined, '', 'false', ' no '])(
    'is not found, and never looks the user up, when OTP_DEV_ECHO is %j',
    async (flag) => {
      if (flag === undefined) delete process.env['OTP_DEV_ECHO'];
      else process.env['OTP_DEV_ECHO'] = flag;
      const { svc, query, auth } = build();
      await expect(svc.login(ok())).rejects.toBeInstanceOf(NotFoundException);
      expect(query.maybeSingle).not.toHaveBeenCalled();
      expect(auth.issueLogin).not.toHaveBeenCalled();
    },
  );

  it('signs in the existing user and returns the login result', async () => {
    const { svc, auth, query } = build();
    await expect(svc.login(ok())).resolves.toEqual({
      token: 't',
      user: { userId: 'u-1' },
    });
    expect(query.eq).toHaveBeenCalledWith('email', 'a@b.co');
    expect(auth.issueLogin).toHaveBeenCalledWith(USER, expect.anything());
  });

  it.each([
    '',
    ' ',
    'yah00mail',
    'YAH00MAIL',
    'yah00Mail ',
    'yah00Mai',
    'x'.repeat(128),
  ])(
    'refuses wrong password %j with the generic 401 and never looks the user up',
    async (pw) => {
      const { svc, query } = build();
      await expect(svc.login(bad('a@b.co', pw))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(query.maybeSingle).not.toHaveBeenCalled();
    },
  );

  it('unknown email, wrong password and disabled user give an identical 401 body', async () => {
    const bodies: unknown[] = [];
    const cases: Array<[unknown, { email: string; password: string }]> = [
      [null, ok()],
      [USER, bad()],
      [{ ...USER, disabled: true }, ok()],
    ];
    for (const [row, creds] of cases) {
      const { svc } = build(row);
      try {
        await svc.login(creds);
      } catch (e) {
        bodies.push((e as UnauthorizedException).getResponse());
      }
    }
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(JSON.stringify(bodies[0])).not.toContain(
      DEV_SHORTCUT_EMAIL_PASSWORD,
    );
  });

  it('a disabled user never gets a token', async () => {
    const { svc, auth } = build({ ...USER, disabled: true });
    await expect(svc.login(ok())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.issueLogin).not.toHaveBeenCalled();
  });

  it('a database error is a server error, not a wrong password, and gives no token', async () => {
    const { svc, auth } = build(null, { code: '57P01', message: 'boom' });
    const err = await svc.login(ok()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect((err as InternalServerErrorException).getStatus()).toBe(500);
    expect((err as InternalServerErrorException).getResponse()).toMatchObject({
      error_code: 'INTERNAL_SERVER_ERROR',
    });
    expect(auth.issueLogin).not.toHaveBeenCalled();
  });

  it('database errors do not count toward the lockout', async () => {
    const { svc, cache, query } = build(null, { code: '57P01', message: 'boom' });
    for (let i = 0; i < EMAIL_LOGIN_MAX_FAILURES + 2; i++) {
      await svc.login(ok()).catch(() => undefined);
    }
    expect(cache.set).not.toHaveBeenCalled();
    // The database comes back: the right password signs in, nothing is locked.
    query.maybeSingle.mockResolvedValue({ data: USER, error: null });
    await expect(svc.login(ok())).resolves.toBeDefined();
  });

  it('a wrong password is counted even when the database is down', async () => {
    const { svc, cache } = build(null, { code: '57P01', message: 'boom' });
    for (let i = 0; i < EMAIL_LOGIN_MAX_FAILURES; i++) {
      await svc.login(bad()).catch(() => undefined);
    }
    expect(cache.set).toHaveBeenCalledTimes(EMAIL_LOGIN_MAX_FAILURES);
  });

  it('locks the email after the allowed failures, even for the right password', async () => {
    const { svc } = build();
    for (let i = 0; i < EMAIL_LOGIN_MAX_FAILURES; i++) {
      await expect(svc.login(bad())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
    const err = await svc.login(ok()).catch((e: HttpException) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({
      error_code: 'RATE_LIMIT_EXCEEDED',
    });
  });

  it('counts failures for unknown emails too, so lockout does not reveal who exists', async () => {
    const { svc } = build(null);
    for (let i = 0; i < EMAIL_LOGIN_MAX_FAILURES; i++) {
      await svc.login(ok('ghost@b.co')).catch(() => undefined);
    }
    const err = await svc
      .login(ok('ghost@b.co'))
      .catch((e: HttpException) => e);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('lockout is per email: another email is unaffected', async () => {
    const { svc } = build();
    for (let i = 0; i < EMAIL_LOGIN_MAX_FAILURES; i++) {
      await svc.login(bad('a@b.co')).catch(() => undefined);
    }
    await expect(svc.login(ok('other@b.co'))).resolves.toBeDefined();
  });

  it('a successful login resets the failure count', async () => {
    const { svc } = build();
    for (let i = 0; i < EMAIL_LOGIN_MAX_FAILURES - 1; i++) {
      await svc.login(bad()).catch(() => undefined);
    }
    await expect(svc.login(ok())).resolves.toBeDefined();
    for (let i = 0; i < EMAIL_LOGIN_MAX_FAILURES - 1; i++) {
      await svc.login(bad()).catch(() => undefined);
    }
    await expect(svc.login(ok())).resolves.toBeDefined();
  });
});

describe('EmailLoginDto', () => {
  const check = async (payload: unknown) =>
    validate(plainToInstance(EmailLoginDto, payload));

  it('accepts a normal body and normalises the email', async () => {
    const dto = plainToInstance(EmailLoginDto, {
      email: '  Admin@Fenzit.COM ',
      password: 'x',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.email).toBe('admin@fenzit.com');
  });

  it.each([
    ['missing email', { password: 'x' }],
    ['missing password', { email: 'a@b.co' }],
    ['empty body', {}],
    ['empty email', { email: '', password: 'x' }],
    ['whitespace email', { email: '   ', password: 'x' }],
    ['no at sign', { email: 'abc', password: 'x' }],
    ['no domain', { email: 'a@', password: 'x' }],
    ['two ats', { email: 'a@@b.co', password: 'x' }],
    ['spaces inside', { email: 'a b@c.co', password: 'x' }],
    ['sql-ish', { email: "a'; drop table users;--@b.co", password: 'x' }],
    ['sql-ish no at', { email: "' or 1=1 --", password: 'x' }],
    ['oversized email', { email: `${'a'.repeat(250)}@b.co`, password: 'x' }],
    ['email as number', { email: 5, password: 'x' }],
    ['email as array', { email: ['a@b.co'], password: 'x' }],
    ['email as object', { email: { $ne: 'x' }, password: 'x' }],
    ['empty password', { email: 'a@b.co', password: '' }],
    ['oversized password', { email: 'a@b.co', password: 'p'.repeat(129) }],
    ['password as number', { email: 'a@b.co', password: 123 }],
    ['password as object', { email: 'a@b.co', password: { a: 1 } }],
  ])('rejects %s', async (_n, payload) => {
    expect((await check(payload)).length).toBeGreaterThan(0);
  });
});
