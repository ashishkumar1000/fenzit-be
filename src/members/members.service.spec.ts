import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { MembersService } from './members.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';

type DbResult = { data: unknown; error: unknown };

/** A query builder that records every filter and resolves to `result`. */
function queryStub(result: DbResult) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const name of [
    'select',
    'eq',
    'neq',
    'in',
    'order',
    'limit',
    'lt',
    'or',
  ]) {
    builder[name] = jest.fn((...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    });
  }
  builder['then'] = (resolve: (v: unknown) => void) => resolve(result);
  return { builder, calls };
}

function build(opts: { query?: DbResult; rpc?: DbResult } = {}) {
  const query = queryStub(opts.query ?? { data: [], error: null });
  const rpc = jest
    .fn()
    .mockResolvedValue(opts.rpc ?? { data: null, error: null });
  const admin = { from: jest.fn(() => query.builder), rpc };
  const factory = {
    createAdmin: jest.fn(() => admin),
  } as unknown as jest.Mocked<SupabaseClientFactory>;
  const storage = {
    presignReadUrl: jest.fn((key: string) =>
      Promise.resolve(`https://signed.example/${key}`),
    ),
  };
  const service = new MembersService(
    factory,
    storage as unknown as StorageService,
  );
  return { service, rpc, from: admin.from, query, storage };
}

const companyAdmin: RequestUser = {
  userId: 'admin-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const platformAdmin: RequestUser = {
  userId: 'staff-1',
  tenantId: null,
  role: null,
  platformAdmin: true,
  rawJwt: 'jwt',
};

/** The message of the error, without the status: what a client reads. */
const bodyOf = (e: unknown) => (e as { getResponse(): unknown }).getResponse();

describe('MembersService', () => {
  describe('list — photo links', () => {
    function memberRowWithPhoto(userId: string, avatarKey: string | null) {
      return {
        user_id: userId,
        role: 'employee',
        status: 'active',
        employee_code: 'EMP-0001',
        created_at: '2026-06-20T00:00:00Z',
        users: {
          name: `Name ${userId}`,
          country_code: '+91',
          phone_number: '9000000000',
          disabled: false,
          avatar_key: avatarKey,
        },
      };
    }

    it('gives a person with a photo a link, and a person without one null', async () => {
      const { service } = build({
        query: {
          data: [
            memberRowWithPhoto('u-1', 'avatars/u-1/a.jpg'),
            memberRowWithPhoto('u-2', null),
          ],
          error: null,
        },
      });

      const members = await service.list(companyAdmin);

      expect(members[0].avatarUrl).toBe(
        'https://signed.example/avatars/u-1/a.jpg',
      );
      expect(members[1].avatarUrl).toBeNull();
    });

    it('never returns the raw storage key as a field', async () => {
      const { service, storage } = build({
        query: {
          data: [memberRowWithPhoto('u-1', 'avatars/u-1/secret-key.jpg')],
          error: null,
        },
      });

      // A presigned link carries its object path by design, so this test
      // uses an opaque link and checks that the key is not a field of its own.
      storage.presignReadUrl.mockResolvedValueOnce(
        'https://signed.example/opaque',
      );

      const members = await service.list(companyAdmin);

      expect(JSON.stringify(members)).not.toContain('secret-key');
      expect(members[0]).not.toHaveProperty('avatarKey');
    });

    it('signs a photo shared by several rows once, not once per row', async () => {
      const { service, storage } = build({
        query: {
          data: [
            memberRowWithPhoto('u-1', 'avatars/u-1/a.jpg'),
            memberRowWithPhoto('u-1-dup', 'avatars/u-1/a.jpg'),
          ],
          error: null,
        },
      });

      await service.list(companyAdmin);

      expect(storage.presignReadUrl).toHaveBeenCalledTimes(1);
    });

    it('still lists everyone when one photo fails to sign: that person gets null, the rest keep theirs', async () => {
      const { service, storage } = build({
        query: {
          data: [
            memberRowWithPhoto('u-1', 'avatars/u-1/broken.jpg'),
            memberRowWithPhoto('u-2', 'avatars/u-2/ok.jpg'),
          ],
          error: null,
        },
      });
      storage.presignReadUrl.mockRejectedValueOnce(new Error('signing failed'));

      const members = await service.list(companyAdmin);

      expect(members).toHaveLength(2);
      expect(members[0].avatarUrl).toBeNull();
      expect(members[1].avatarUrl).toBe(
        'https://signed.example/avatars/u-2/ok.jpg',
      );
    });
  });

  describe('changeRole', () => {
    it('sends the caller, company, member and new role to the database function', async () => {
      const { service, rpc } = build({
        rpc: {
          data: [{ old_role: 'employee', new_role: 'viewer' }],
          error: null,
        },
      });
      await service.changeRole(companyAdmin, 'member-1', 'viewer' as never);
      expect(rpc).toHaveBeenCalledWith('change_member_role', {
        p_caller: 'admin-1',
        p_tenant_id: 'tenant-A',
        p_member_user_id: 'member-1',
        p_new_role: 'viewer',
      });
    });

    it('reports the real old and new roles from the database', async () => {
      const { service } = build({
        rpc: {
          data: [{ old_role: 'employee', new_role: 'company_admin' }],
          error: null,
        },
      });
      await expect(
        service.changeRole(companyAdmin, 'member-1', 'company_admin' as never),
      ).resolves.toEqual({
        userId: 'member-1',
        oldRole: 'employee',
        newRole: 'company_admin',
      });
    });

    it('fails loudly, never a made-up change, when the database returns no role row', async () => {
      const { service } = build({ rpc: { data: [], error: null } });
      const err = await service
        .changeRole(companyAdmin, 'member-1', 'viewer' as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(bodyOf(err)).toMatchObject({
        error_code: 'INTERNAL_SERVER_ERROR',
      });
    });

    it('turns the last-admin refusal into a 409 with its own code', async () => {
      const { service } = build({
        rpc: {
          data: null,
          error: { code: 'PT409', hint: 'LAST_ADMIN', message: 'x' },
        },
      });
      const err = await service
        .changeRole(companyAdmin, 'member-1', 'viewer' as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'LAST_ADMIN' });
    });

    it('hides an unknown database error behind a generic 500, with no database text', async () => {
      const { service } = build({
        rpc: {
          data: null,
          error: { code: '42501', message: 'permission denied for table x' },
        },
      });
      const err = await service
        .changeRole(companyAdmin, 'member-1', 'viewer' as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(JSON.stringify(bodyOf(err))).not.toContain('permission denied');
    });
  });

  describe('remove', () => {
    it('removes the named member inside the caller company only', async () => {
      const { service, rpc } = build({ rpc: { data: null, error: null } });
      await service.remove(companyAdmin, 'member-1');
      expect(rpc).toHaveBeenCalledWith('remove_member', {
        p_caller: 'admin-1',
        p_tenant_id: 'tenant-A',
        p_member_user_id: 'member-1',
      });
    });

    it('maps a not-found member to 404', async () => {
      const { service } = build({
        rpc: {
          data: null,
          error: { code: 'PT404', hint: 'RESOURCE_NOT_FOUND', message: 'x' },
        },
      });
      await expect(service.remove(companyAdmin, 'ghost')).rejects.toMatchObject(
        {
          status: 404,
        },
      );
    });
  });

  describe('setDisabled', () => {
    it('disables a person and says so', async () => {
      const { service, rpc } = build({ rpc: { data: true, error: null } });
      await expect(
        service.setDisabled(platformAdmin, 'person-1', true),
      ).resolves.toEqual({ userId: 'person-1', disabled: true });
      expect(rpc).toHaveBeenCalledWith('set_user_disabled', {
        p_caller: 'staff-1',
        p_user_id: 'person-1',
        p_disabled: true,
      });
    });

    it('enables a person and says so (the database returns false)', async () => {
      const { service } = build({ rpc: { data: false, error: null } });
      await expect(
        service.setDisabled(platformAdmin, 'person-1', false),
      ).resolves.toEqual({ userId: 'person-1', disabled: false });
    });

    it('never reports disabled when the database gives a value other than true', async () => {
      const { service } = build({ rpc: { data: null, error: null } });
      await expect(
        service.setDisabled(platformAdmin, 'person-1', true),
      ).resolves.toEqual({ userId: 'person-1', disabled: false });
    });

    it('refuses to disable the last active admin with a 409 and the LAST_ADMIN code', async () => {
      const { service } = build({
        rpc: {
          data: null,
          error: { code: 'PT409', hint: 'LAST_ADMIN', message: 'x' },
        },
      });
      const err = await service
        .setDisabled(platformAdmin, 'admin-1', true)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'LAST_ADMIN' });
    });
  });

  describe('auditLog', () => {
    it('reads only the caller company for a company admin', async () => {
      const { service, query } = build();
      await service.auditLog(companyAdmin, undefined, undefined);
      expect(query.calls).toContainEqual(['eq', ['tenant_id', 'tenant-A']]);
    });

    it('cannot be widened by the caller: a company admin is always scoped', async () => {
      const { service, query } = build();
      await service.auditLog(
        { ...companyAdmin, tenantId: 'tenant-A' },
        undefined,
        undefined,
      );
      const tenantFilters = query.calls.filter(
        ([name, args]) => name === 'eq' && args[0] === 'tenant_id',
      );
      expect(tenantFilters).toHaveLength(1);
    });

    it('a platform admin who named a company sees only that company', async () => {
      const { service, query } = build();
      await service.auditLog(
        { ...platformAdmin, tenantId: 'tenant-B' },
        undefined,
        undefined,
      );
      expect(query.calls).toContainEqual(['eq', ['tenant_id', 'tenant-B']]);
    });

    it('a platform admin who named no company sees every company', async () => {
      const { service, query } = build();
      await service.auditLog(platformAdmin, undefined, undefined);
      expect(query.calls.map(([name]) => name)).not.toContain('eq');
    });

    it('returns 50 rows by default and never more than the limit asked for', async () => {
      const { service, query } = build();
      await service.auditLog(companyAdmin, undefined, undefined);
      expect(query.calls).toContainEqual(['limit', [50]]);
      await service.auditLog(companyAdmin, 7, undefined);
      expect(query.calls).toContainEqual(['limit', [7]]);
    });

    it('orders newest first, with id as the tie-breaker', async () => {
      const { service, query } = build();
      await service.auditLog(companyAdmin, undefined, undefined);
      expect(query.calls).toContainEqual([
        'order',
        ['created_at', { ascending: false }],
      ]);
      expect(query.calls).toContainEqual([
        'order',
        ['id', { ascending: false }],
      ]);
    });

    it('rejects a beforeId sent without before, rather than ignoring it', async () => {
      const { service, from } = build();
      const err = await service
        .auditLog(
          companyAdmin,
          undefined,
          undefined,
          '11111111-1111-1111-1111-111111111111',
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'VALIDATION_ERROR' });
      expect(from).not.toHaveBeenCalled();
    });

    it('pages by timestamp when only before is sent', async () => {
      const { service, query } = build();
      await service.auditLog(companyAdmin, undefined, '2026-10-01T00:00:00Z');
      expect(query.calls).toContainEqual([
        'lt',
        ['created_at', '2026-10-01T00:00:00Z'],
      ]);
    });

    it('pages by (timestamp, id) when both are sent, so same-second rows are not skipped', async () => {
      const { service, query } = build();
      await service.auditLog(
        companyAdmin,
        undefined,
        '2026-10-01T00:00:00Z',
        '22222222-2222-2222-2222-222222222222',
      );
      expect(query.calls).toContainEqual([
        'or',
        [
          'created_at.lt."2026-10-01T00:00:00Z",and(created_at.eq."2026-10-01T00:00:00Z",id.lt.22222222-2222-2222-2222-222222222222)',
        ],
      ]);
    });

    it('maps each row, defaulting a missing target and details', async () => {
      const { service } = build({
        query: {
          data: [
            {
              id: 'a-1',
              created_at: '2026-10-01T00:00:00Z',
              actor_user_id: 'admin-1',
              actor_is_platform_admin: false,
              tenant_id: 'tenant-A',
              action: 'member.remove',
              target_user_id: null,
              details: null,
            },
          ],
          error: null,
        },
      });
      await expect(
        service.auditLog(companyAdmin, undefined, undefined),
      ).resolves.toEqual([
        {
          id: 'a-1',
          createdAt: '2026-10-01T00:00:00Z',
          actorUserId: 'admin-1',
          actorIsPlatformAdmin: false,
          tenantId: 'tenant-A',
          action: 'member.remove',
          targetUserId: null,
          details: {},
        },
      ]);
    });

    it('answers a read failure with a generic 500', async () => {
      const { service } = build({
        query: { data: null, error: { code: '57P01', message: 'boom' } },
      });
      const err = await service
        .auditLog(companyAdmin, undefined, undefined)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(bodyOf(err)).toMatchObject({
        error_code: 'INTERNAL_SERVER_ERROR',
      });
    });
  });
});
