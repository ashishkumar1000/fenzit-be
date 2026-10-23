import {
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  EMAIL_LINK_MAX_TAKEN_ANSWERS,
  EmailLinkService,
} from './email-link.service';
import { LinkEmailDto } from './dto/link-email.dto';

interface ReadQuery {
  maybeSingle: jest.Mock;
}
interface UpdateQuery {
  update: jest.Mock;
  maybeSingle: jest.Mock;
}

function build(
  opts: {
    row?: unknown;
    readError?: unknown;
    updated?: unknown;
    updateError?: unknown;
  } = {},
) {
  // The common case: the user exists and has no email yet.
  const row = opts.row === undefined ? { email: null } : opts.row;
  const reads: ReadQuery[] = [];
  const updates: UpdateQuery[] = [];
  const makeRead = () => {
    const q = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: row, error: opts.readError ?? null }),
    };
    reads.push(q);
    return q;
  };
  const makeUpdate = () => {
    const q = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: opts.updated ?? null,
        error: opts.updateError ?? null,
      }),
    };
    updates.push(q);
    return q;
  };
  // One link() call reads the user first, then writes. Odd calls read, even calls write.
  const admin = {
    from: jest.fn(() =>
      admin.from.mock.calls.length % 2 === 1 ? makeRead() : makeUpdate(),
    ),
  };
  const factory = { createAdmin: jest.fn().mockReturnValue(admin) };
  const store = new Map<string, unknown>();
  const cache = {
    get: jest.fn((k: string) => Promise.resolve(store.get(k))),
    set: jest.fn((k: string, v: unknown) => {
      store.set(k, v);
      return Promise.resolve();
    }),
    del: jest.fn((k: string) => {
      store.delete(k);
      return Promise.resolve();
    }),
  };
  const svc = new EmailLinkService(factory as never, cache as never);
  return { svc, admin, reads, updates, cache, store };
}

const USER_ID = 'u-1';

describe('EmailLinkService: the no-op and conflict paths', () => {
  it('setting the email the account already has is a no-op that answers 200', async () => {
    const { svc, admin } = build({ row: { email: 'owner@example.com' } });

    await expect(svc.link(USER_ID, 'owner@example.com')).resolves.toEqual({
      email: 'owner@example.com',
    });
    // Only the read happened; nothing was written.
    expect(admin.from).toHaveBeenCalledTimes(1);
  });

  it('an account that already has a different email cannot change it here', async () => {
    const { svc, admin } = build({ row: { email: 'old@example.com' } });

    const err = await svc
      .link(USER_ID, 'new@example.com')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error_code: 'DUPLICATE_RESOURCE',
      message: 'This account already has an email linked.',
    });
    expect(admin.from).toHaveBeenCalledTimes(1);
  });

  it('a signed-in user with no row is not found', async () => {
    const { svc } = build({ row: null });

    const err = await svc
      .link(USER_ID, 'owner@example.com')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({
      error_code: 'RESOURCE_NOT_FOUND',
    });
  });
});

describe('EmailLinkService: linking an email', () => {
  it('saves the email only while the row still has none', async () => {
    const { svc, updates } = build({ updated: { email: 'owner@example.com' } });

    await expect(svc.link(USER_ID, 'owner@example.com')).resolves.toEqual({
      email: 'owner@example.com',
    });
    const write = updates[0];
    expect(write.update).toHaveBeenCalledWith({ email: 'owner@example.com' });
    expect(write.eq).toHaveBeenCalledWith('id', USER_ID);
    // The empty-check makes two parallel requests unable to overwrite each other.
    expect(write.is).toHaveBeenCalledWith('email', null);
  });

  it('answers with the stored email, not the requested one', async () => {
    const { svc } = build({ updated: { email: 'stored@example.com' } });

    await expect(svc.link(USER_ID, 'asked@example.com')).resolves.toEqual({
      email: 'stored@example.com',
    });
  });

  it('a row that stopped being empty before the write is a conflict, not a silent overwrite', async () => {
    // .is('email', null) matched nothing, so no row came back.
    const { svc } = build({ updated: null });

    const err = await svc
      .link(USER_ID, 'owner@example.com')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      message: 'This account already has an email linked.',
    });
  });
});

describe('EmailLinkService: the address belongs to another account', () => {
  it('answers 409 and counts the taken answer', async () => {
    const { svc, cache } = build({
      updateError: { code: '23505', message: 'unique' },
    });

    const err = await svc
      .link(USER_ID, 'taken@example.com')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      error_code: 'DUPLICATE_RESOURCE',
      message: 'That email is already linked to another account.',
    });
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it(`pauses the user with 429 after ${EMAIL_LINK_MAX_TAKEN_ANSWERS} taken answers`, async () => {
    const { svc, admin } = build({
      updateError: { code: '23505', message: 'unique' },
    });

    for (let i = 0; i < EMAIL_LINK_MAX_TAKEN_ANSWERS; i++) {
      await svc.link(USER_ID, 'taken@example.com').catch(() => undefined);
    }
    admin.from.mockClear();
    const err = await svc
      .link(USER_ID, 'taken@example.com')
      .catch((e: HttpException) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toMatchObject({
      error_code: 'RATE_LIMIT_EXCEEDED',
    });
    expect(err.getResponse()).toHaveProperty('retryAfterSeconds');
    // A paused user costs the database nothing, so probing cannot continue.
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('the retry hint names the time actually left in the window', async () => {
    const { svc, store } = build({});
    const remainingMs = 120_000;
    store.set('email-link:taken:u-1', {
      count: EMAIL_LINK_MAX_TAKEN_ANSWERS,
      expiresAt: Date.now() + remainingMs,
    });

    const err = await svc
      .link(USER_ID, 'taken@example.com')
      .catch((e: HttpException) => e);

    expect(err.getStatus()).toBe(429);
    const retry = (err.getResponse() as { retryAfterSeconds: number })
      .retryAfterSeconds;
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(remainingMs / 1000);
  });

  it('keeps the window’s original end, so probing cannot extend the pause', async () => {
    const { svc, cache, store } = build({
      updateError: { code: '23505', message: 'unique' },
    });
    const originalEnd = Date.now() + 60_000;
    store.set('email-link:taken:u-1', { count: 3, expiresAt: originalEnd });

    await svc.link(USER_ID, 'taken@example.com').catch(() => undefined);

    expect(cache.set).toHaveBeenCalledWith(
      'email-link:taken:u-1',
      { count: 4, expiresAt: originalEnd },
      expect.any(Number),
    );
  });

  it(`answers through again below the limit: ${EMAIL_LINK_MAX_TAKEN_ANSWERS - 1} taken answers do not pause`, async () => {
    const { svc, store } = build({ updated: { email: 'owner@example.com' } });
    store.set('email-link:taken:u-1', {
      count: EMAIL_LINK_MAX_TAKEN_ANSWERS - 1,
      expiresAt: Date.now() + 60_000,
    });

    await expect(svc.link(USER_ID, 'owner@example.com')).resolves.toBeDefined();
  });

  it('the pause is per user: another account sharing the cache is unaffected', async () => {
    const opts: {
      row?: unknown;
      readError?: unknown;
      updated?: unknown;
      updateError?: unknown;
    } = { updateError: { code: '23505', message: 'unique' } };
    const { svc, store } = build(opts);
    for (let i = 0; i < EMAIL_LINK_MAX_TAKEN_ANSWERS; i++) {
      await svc.link(USER_ID, 'taken@example.com').catch(() => undefined);
    }
    // Exactly one pause entry exists, and its key names this user.
    expect([...store.keys()]).toEqual([`email-link:taken:${USER_ID}`]);

    // u-2 now links against the same service and the same cache. A key that
    // ignored the user id would pause them too. Their write succeeds this time.
    opts.updated = { email: 'other@example.com' };
    delete opts.updateError;
    await expect(svc.link('u-2', 'other@example.com')).resolves.toEqual({
      email: 'other@example.com',
    });
  });
});

describe('EmailLinkService: database failures', () => {
  it('an email that fails the format check is a 422, not a server error', async () => {
    const { svc } = build({
      updateError: {
        code: '23514',
        message: 'new row violates check constraint "users_email_format"',
      },
    });

    const err = await svc
      .link(USER_ID, 'not-an-email')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({
      error_code: 'VALIDATION_ERROR',
      message: 'Enter a valid email address.',
    });
  });

  it('any other check violation is a server fault', async () => {
    const { svc } = build({
      updateError: {
        code: '23514',
        message: 'violates check constraint "users_something_else"',
      },
    });

    const err = await svc
      .link(USER_ID, 'owner@example.com')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect((err as InternalServerErrorException).getResponse()).toMatchObject({
      error_code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('a read failure is a 500 that never echoes the email', async () => {
    const { svc } = build({ readError: { code: '57P01', message: 'down' } });

    const err = await svc
      .link(USER_ID, 'secret-person@example.com')
      .catch((e: InternalServerErrorException) => e);

    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(JSON.stringify(err.getResponse())).not.toContain('secret-person');
  });

  it('database failures do not count toward the pause', async () => {
    const { svc, cache } = build({
      readError: { code: '57P01', message: 'down' },
    });

    for (let i = 0; i < EMAIL_LINK_MAX_TAKEN_ANSWERS + 2; i++) {
      await svc.link(USER_ID, 'owner@example.com').catch(() => undefined);
    }

    expect(cache.set).not.toHaveBeenCalled();
  });

  it('a written email is never logged', async () => {
    // The only error log the service writes is the server-error path; the
    // email must not appear in it.
    const { svc } = build({ readError: { code: '57P01', message: 'down' } });
    const loggerError = jest
      .spyOn(
        (svc as unknown as { logger: { error: jest.Mock } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);

    await svc.link(USER_ID, 'private@example.com').catch(() => undefined);

    expect(loggerError).toHaveBeenCalled();
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      'private@example.com',
    );
  });
});

describe('LinkEmailDto', () => {
  const check = async (payload: unknown) =>
    validate(plainToInstance(LinkEmailDto, payload));

  it('accepts a normal body and normalises it to one lowercase address', async () => {
    const dto = plainToInstance(LinkEmailDto, { email: '  Owner@Fenzit.COM ' });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.email).toBe('owner@fenzit.com');
  });

  it.each([
    ['missing email', {}],
    ['empty email', { email: '' }],
    ['whitespace email', { email: '   ' }],
    ['no at sign', { email: 'owner' }],
    ['no domain', { email: 'owner@' }],
    ['two ats', { email: 'a@@b.co' }],
    ['spaces inside', { email: 'a b@c.co' }],
    ['255 characters, one over the cap', { email: `${'a'.repeat(249)}@b.co` }],
    ['email as number', { email: 5 }],
    ['email as array', { email: ['a@b.co'] }],
    ['email as object', { email: { $ne: 'x' } }],
  ])('rejects %s', async (_name, payload) => {
    expect((await check(payload)).length).toBeGreaterThan(0);
  });

  it('accepts an address of exactly 254 characters with every part inside its own limit', async () => {
    // IsEmail also caps the local part at 64 and each domain label at 63, so a
    // 254-character address needs to spread its length across the domain.
    const email = `${'a'.repeat(61)}@${'b'.repeat(63)}.${'c'.repeat(62)}.${'d'.repeat(62)}.co`;
    expect(email).toHaveLength(254);
    const dto = plainToInstance(LinkEmailDto, { email });

    expect(await validate(dto)).toHaveLength(0);
  });
});
