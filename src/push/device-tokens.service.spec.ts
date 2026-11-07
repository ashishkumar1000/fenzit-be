import { InternalServerErrorException, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { DeviceTokensService } from './device-tokens.service';
import type { RegisterDeviceTokenDto } from './dto/register-device-token.dto';

const TOKEN = 'dGVzdC1mY20tdG9rZW4tZm9yLXVuaXQtdGVzdHM6QVBBOTFiRWNyZXQ';
const USER: RequestUser = {
  userId: '0f5e6d7c-8a9b-4c0d-8e1f-2a3b4c5d6e7f',
  tenantId: 'f9d5ca79-a245-4a0d-9393-e4a2af718885',
  role: 'technician',
  platformAdmin: false,
  rawJwt: 'jwt',
} as unknown as RequestUser;
const OTHER_USER_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('DeviceTokensService', () => {
  let query: jest.Mock;
  let service: DeviceTokensService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const tx = { query } as unknown as PoolClient;
    const pg = {
      withTransaction: jest.fn((fn: (c: PoolClient) => Promise<unknown>) =>
        fn(tx),
      ),
    } as unknown as PgPoolFactory;
    service = new DeviceTokensService(pg);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('register', () => {
    const dto = (over: Partial<RegisterDeviceTokenDto> = {}) =>
      ({ token: TOKEN, platform: 'android', ...over }) as RegisterDeviceTokenDto;

    it('binds the row to the JWT user, never to anything in the body', async () => {
      // A hostile body trying to name another user must have no effect.
      const hostile = {
        token: TOKEN,
        platform: 'android',
        userId: OTHER_USER_ID,
        user_id: OTHER_USER_ID,
      } as unknown as RegisterDeviceTokenDto;

      await service.register(USER, hostile);

      const params = query.mock.calls[0][1] as unknown[];
      expect(params).toEqual([TOKEN, USER.userId, 'android', null]);
      expect(params).not.toContain(OTHER_USER_ID);
    });

    it('rebinds an existing token on conflict and clears the stale failure', async () => {
      await service.register(USER, dto({ appVersion: '1.2.1' }));

      const sql = query.mock.calls[0][0] as string;
      expect(sql).toMatch(/on conflict \(token\) do update/);
      expect(sql).toMatch(/user_id\s*=\s*excluded\.user_id/);
      expect(sql).toMatch(/last_failure\s*=\s*null/);
    });

    it('stores a null app version when the client omits it', async () => {
      await service.register(USER, dto());
      expect(query.mock.calls[0][1]).toEqual([TOKEN, USER.userId, 'android', null]);
    });

    it('passes the app version through when given', async () => {
      await service.register(USER, dto({ appVersion: '1.2.1' }));
      expect(query.mock.calls[0][1]).toEqual([
        TOKEN,
        USER.userId,
        'android',
        '1.2.1',
      ]);
    });

    it('maps a database failure to a 500 and logs only a token prefix', async () => {
      query.mockRejectedValueOnce(
        Object.assign(new Error('connection refused'), { code: '08006' }),
      );
      const errorSpy = jest.spyOn(Logger.prototype, 'error');

      await expect(service.register(USER, dto())).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );

      const logged = JSON.stringify(errorSpy.mock.calls);
      expect(logged).toContain(TOKEN.slice(0, 12));
      expect(logged).not.toContain(TOKEN);
    });
  });

  describe('unregister', () => {
    it('deletes only the caller\'s own row for the token', async () => {
      await service.unregister(USER, TOKEN);

      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/where token = \$1 and user_id = \$2/);
      expect(params).toEqual([TOKEN, USER.userId]);
    });

    it('resolves silently when the token belongs to another user (no 404, no leak)', async () => {
      // Foreign row: the DELETE matches zero rows and the call still succeeds.
      query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(service.unregister(USER, TOKEN)).resolves.toBeUndefined();
    });

    it('resolves silently when the token is already gone (logout retry)', async () => {
      await expect(service.unregister(USER, TOKEN)).resolves.toBeUndefined();
    });

    it('maps a database failure to a 500 without logging the full token', async () => {
      query.mockRejectedValueOnce(new Error('timeout'));
      const errorSpy = jest.spyOn(Logger.prototype, 'error');

      await expect(service.unregister(USER, TOKEN)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );

      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TOKEN);
    });

    it('never logs a constraint error detail, which carries the full token row', async () => {
      // A Postgres constraint error puts the offending row (token included) in
      // err.detail. The logger must receive the error code only.
      const pgError = Object.assign(new Error('violates check constraint'), {
        code: '23514',
        detail: `Failing row contains (${TOKEN}, ${USER.userId})`,
      });
      query.mockRejectedValueOnce(pgError);
      const errorSpy = jest.spyOn(Logger.prototype, 'error');

      await expect(service.unregister(USER, TOKEN)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );

      expect(errorSpy).toHaveBeenCalled();
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TOKEN);
      expect(JSON.stringify(errorSpy.mock.calls)).toContain('23514');
    });
  });
});
