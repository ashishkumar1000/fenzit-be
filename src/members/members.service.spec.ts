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
import { UpdateEmploymentDto } from './dto/update-employment.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

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

/** The canonical fixture's Employee A (spec-payroll), as the API carries it. */
const fullFormV = {
  employeeCode: 'EMP-001',
  joinDate: '2026-09-01',
  exitDate: null,
  pan: 'ABCPE1234F',
  dateOfBirth: '1995-04-12',
  fatherName: 'Ramesh Sharma',
  motherName: 'Sunita Sharma',
  spouseName: 'Meera Sharma',
  pfAccountNumber: 'PY/ABC/12345/000',
  uanNumber: '101234567890',
  designation: 'Field Technician',
  department: 'Field Operations',
  bankAccountNumber: '1234567890',
  ifscCode: 'HDFC0001234',
  bankName: 'HDFC Bank',
};

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

  describe('employment (CAP-13)', () => {
    /**
     * The employment endpoints talk to the memberships TABLE (not a database
     * function). This stand-in recognises each builder by what it does — a
     * write is an update, a `select('user_id')` is the employee-code probe,
     * anything else is the row read — and answers with the matching result.
     */
    function buildEmployment(
      opts: {
        row?: Record<string, unknown> | null;
        probeRow?: { user_id: string } | null;
        updateResult?: Record<string, unknown> | null;
        updateError?: { code?: string; message?: string } | null;
        rpcResult?: { data: unknown; error: unknown };
        rpcRejects?: unknown;
      } = {},
    ) {
      const updatesPayloads: Array<Record<string, unknown>> = [];
      const stepLog: string[] = [];

      const mkBuilder = () => {
        const b: Record<string, unknown> = {};
        let selectArg: unknown = null;
        let updated = false;
        for (const name of ['eq', 'neq', 'in', 'order', 'limit', 'lt', 'or']) {
          b[name] = jest.fn((...args: unknown[]) => {
            stepLog.push(`${name}(${JSON.stringify(args)})`);
            return b;
          });
        }
        b['select'] = jest.fn((...args: unknown[]) => {
          selectArg = args[0];
          stepLog.push(`select(${JSON.stringify(args)})`);
          return b;
        });
        b['update'] = jest.fn((payload: Record<string, unknown>) => {
          updated = true;
          stepLog.push(`update(${JSON.stringify(payload)})`);
          updatesPayloads.push(payload);
          return b;
        });
        b['maybeSingle'] = jest.fn(() => b);
        b['single'] = jest.fn(() => b);
        b['then'] = (resolve: (v: unknown) => void) => {
          if (updated) {
            resolve({
              data: opts.updateResult ?? null,
              error: opts.updateError ?? null,
            });
            return;
          }
          if (selectArg === 'user_id') {
            resolve({ data: opts.probeRow ?? null, error: null });
            return;
          }
          resolve({ data: opts.row ?? null, error: null });
        };
        return b;
      };

      const from = jest.fn(() => mkBuilder());
      const rpc =
        opts.rpcRejects !== undefined
          ? jest.fn().mockRejectedValue(opts.rpcRejects)
          : jest
              .fn()
              .mockResolvedValue(opts.rpcResult ?? { data: null, error: null });
      const admin = { from, rpc };
      const factory = {
        createAdmin: jest.fn(() => admin),
      } as unknown as jest.Mocked<SupabaseClientFactory>;
      const storage = {
        presignReadUrl: jest.fn(),
      };
      const service = new MembersService(
        factory,
        storage as unknown as StorageService,
      );
      return { service, from, rpc, updatesPayloads, stepLog };
    }

    const employmentRow = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      user_id: 'member-1',
      employee_code: 'EMP-001',
      join_date: '2026-09-01',
      exit_date: null,
      pan: null,
      date_of_birth: null,
      father_name: null,
      mother_name: null,
      spouse_name: null,
      pf_account_number: null,
      uan_number: null,
      designation: null,
      department: null,
      bank_account_number: null,
      ifsc_code: null,
      bank_name: null,
      ...overrides,
    });

    const employmentErrorOf = async (
      run: () => Promise<unknown>,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const err = await run().catch((e: unknown) => e);
      return {
        status: (err as { status?: number }).status ?? 0,
        body: bodyOf(err) as Record<string, unknown>,
      };
    };

    it('get — answers the whole Form V field set, names mapped from the columns', async () => {
      const { service } = buildEmployment({
        row: employmentRow({
          pan: 'ABCPE1234F',
          designation: 'Field Technician',
        }),
      });
      await expect(
        service.getEmployment(companyAdmin, 'member-1'),
      ).resolves.toMatchObject({
        userId: 'member-1',
        employeeCode: 'EMP-001',
        joinDate: '2026-09-01',
        pan: 'ABCPE1234F',
        designation: 'Field Technician',
        bankName: null,
      });
    });

    it('get — reads by user AND company with no status filter, so a removed member is served', async () => {
      const { service, stepLog } = buildEmployment({ row: employmentRow() });
      await service.getEmployment(companyAdmin, 'member-1');
      expect(stepLog.join('\n')).toContain(
        JSON.stringify(['user_id', 'member-1']),
      );
      expect(stepLog.join('\n')).toContain(
        JSON.stringify(['tenant_id', 'tenant-A']),
      );
      expect(stepLog.join('\n')).not.toContain('neq');
    });

    it('get — answers 404 when the person is not a member of the caller company', async () => {
      const { service } = buildEmployment({ row: null });
      const { status, body } = await employmentErrorOf(() =>
        service.getEmployment(companyAdmin, 'stranger-1'),
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    });

    it('a caller with no company is refused before any read', async () => {
      const { service, from } = buildEmployment({ row: employmentRow() });
      const { status } = await employmentErrorOf(() =>
        service.getEmployment({ ...companyAdmin, tenantId: null }, 'member-1'),
      );
      expect(status).toBe(400);
      expect(from).not.toHaveBeenCalled();
    });

    it('saves the full Form V set and writes exactly one audit entry naming the fields, never the values', async () => {
      const saved = employmentRow({
        pan: 'ABCPE1234F',
        date_of_birth: '1995-04-12',
        father_name: 'Ramesh Sharma',
        pf_account_number: 'PY/ABC/12345/000',
        uan_number: '101234567890',
        designation: 'Field Technician',
        department: 'Field Operations',
        bank_account_number: '1234567890',
        ifsc_code: 'HDFC0001234',
        bank_name: 'HDFC Bank',
      });
      const { service, rpc, updatesPayloads } = buildEmployment({
        row: employmentRow(),
        updateResult: saved,
      });
      await service.updateEmployment(companyAdmin, 'member-1', fullFormV);
      expect(rpc).toHaveBeenCalledTimes(1);
      const call = rpc.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(call[0]).toBe('write_audit_row');
      expect(call[1].p_action).toBe('member.employment_update');
      expect(call[1].p_target_user).toBe('member-1');
      const details = call[1].p_details as Record<string, unknown>;
      expect(details['changed_fields']).toEqual(
        expect.arrayContaining([
          'pan',
          'date_of_birth',
          'father_name',
          'bank_name',
        ]),
      );
      expect(details['old_employee_code']).toBe('EMP-001');
      expect(details['new_employee_code']).toBe('EMP-001');
      expect(JSON.stringify(details)).not.toContain('ABCPE1234F');
      expect(JSON.stringify(details)).not.toContain('Ramesh');
      // The write itself carries every field — the column names, not the DTO keys.
      const payload = updatesPayloads[0];
      expect(payload).toMatchObject({
        pan: 'ABCPE1234F',
        date_of_birth: '1995-04-12',
        father_name: 'Ramesh Sharma',
        bank_account_number: '1234567890',
        ifsc_code: 'HDFC0001234',
      });
      expect(payload).not.toHaveProperty('pan2');
      expect(payload).not.toHaveProperty('dateOfBirth');
    });

    it('an identical repeat save writes no audit row and no update', async () => {
      const { service, rpc, from } = buildEmployment({
        row: employmentRow({
          pan: 'ABCPE1234F',
          father_name: 'Ramesh Sharma',
        }),
      });
      await service.updateEmployment(companyAdmin, 'member-1', {
        pan: 'ABCPE1234F',
        fatherName: 'Ramesh Sharma',
      });
      expect(from).toHaveBeenCalledTimes(1); // the read only
      expect(rpc).not.toHaveBeenCalled();
    });

    it('null clears a value; an absent key leaves it alone', async () => {
      const { service, updatesPayloads } = buildEmployment({
        row: employmentRow({ father_name: 'Ramesh Sharma' }),
        updateResult: employmentRow({ father_name: null }),
      });
      await service.updateEmployment(companyAdmin, 'member-1', {
        fatherName: null,
      });
      expect(updatesPayloads[0]).toEqual({ father_name: null });

      const second = buildEmployment({
        row: employmentRow({ father_name: 'Ramesh Sharma' }),
        updateResult: employmentRow(),
      });
      await second.service.updateEmployment(companyAdmin, 'member-1', {
        pan: 'ABCPE1234F',
      });
      expect(second.updatesPayloads[0]).toEqual({ pan: 'ABCPE1234F' });
    });

    it('values are trimmed; empty after the trim is a clear', async () => {
      const { service, updatesPayloads } = buildEmployment({
        row: employmentRow({
          designation: null,
          department: 'Field Operations',
        }),
        updateResult: employmentRow(),
      });
      await service.updateEmployment(companyAdmin, 'member-1', {
        designation: '  Field Technician  ',
        department: '   ',
      });
      expect(updatesPayloads[0]).toEqual({
        designation: 'Field Technician',
        department: null,
      });
    });

    it('clearing the join date is allowed — the skip path stays real', async () => {
      const { service, updatesPayloads, rpc } = buildEmployment({
        row: employmentRow({ join_date: '2026-09-01' }),
        updateResult: employmentRow({ join_date: null }),
      });
      await expect(
        service.updateEmployment(companyAdmin, 'member-1', { joinDate: null }),
      ).resolves.toMatchObject({ joinDate: null });
      expect(updatesPayloads[0]).toEqual({ join_date: null });
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('validation order — an invented calendar date is called out before anything else', async () => {
      const { service } = buildEmployment({ row: employmentRow() });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          joinDate: '2026-02-30',
          employeeCode: null,
        }),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('joinDate');
      expect(String(body['message'])).not.toContain('employee code');
    });

    it('validation order — a cleared employee code is refused before the join/exit rules', async () => {
      const { service } = buildEmployment({ row: employmentRow() });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          employeeCode: null,
          exitDate: '2026-01-01',
        }),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('permanent');
      expect(String(body['message'])).not.toContain('exit');
    });

    it('an exit needs a join — judged on the state after this save', async () => {
      const { service } = buildEmployment({
        row: employmentRow({ join_date: null }),
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          exitDate: '2026-09-01',
        }),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('joining date');
    });

    it('clearing the join and setting an exit in one request is the same refusal', async () => {
      const { service } = buildEmployment({
        row: employmentRow({ join_date: '2026-10-01' }),
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          joinDate: null,
          exitDate: '2026-09-01',
        }),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('joining date');
    });

    it('an exit before the join is refused', async () => {
      const { service } = buildEmployment({
        row: employmentRow({ join_date: '2026-10-01' }),
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          exitDate: '2026-09-01',
        }),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('cannot be before');
    });

    it('a clash found by the probe answers 409 naming the code, and never writes', async () => {
      const { service, from, stepLog } = buildEmployment({
        row: employmentRow(),
        probeRow: { user_id: 'other-member' },
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          employeeCode: 'EMP-002',
        }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'DUPLICATE_RESOURCE' });
      expect(String(body['message'])).toContain('EMP-002');
      expect(from).toHaveBeenCalledTimes(2); // read + probe, no write
      expect(stepLog.join('\n')).not.toContain('.update(');
    });

    it('a 23505 unique violation that slips past the probe still answers the 409', async () => {
      const { service } = buildEmployment({
        row: employmentRow(),
        updateError: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "memberships_tenant_employee_code_key"',
        },
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          employeeCode: 'EMP-002',
        }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'DUPLICATE_RESOURCE' });
      expect(String(body['message'])).toContain('EMP-002');
    });

    it('a failed audit write that RESOLVES with an error still saves', async () => {
      const { service } = buildEmployment({
        row: employmentRow(),
        updateResult: employmentRow({ designation: 'Field Technician' }),
        rpcResult: {
          data: null,
          error: { code: 'PT403', message: 'forbidden' },
        },
      });
      await expect(
        service.updateEmployment(companyAdmin, 'member-1', {
          designation: 'Field Technician',
        }),
      ).resolves.toMatchObject({ designation: 'Field Technician' });
    });

    it('a REJECTED audit write (network) still saves too', async () => {
      const { service } = buildEmployment({
        row: employmentRow(),
        updateResult: employmentRow({ designation: 'Field Technician' }),
        rpcRejects: new Error('network down'),
      });
      await expect(
        service.updateEmployment(companyAdmin, 'member-1', {
          designation: 'Field Technician',
        }),
      ).resolves.toMatchObject({ designation: 'Field Technician' });
    });

    it('a member deleted between the read and the write answers 404, not a 500', async () => {
      const { service } = buildEmployment({
        row: employmentRow(),
        updateError: { code: 'PGRST116', message: 'no rows returned' },
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          designation: 'Field Technician',
        }),
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    });

    it('a CHECK the write tripped on a stale read answers 409 with a reload hint', async () => {
      const { service } = buildEmployment({
        row: employmentRow(),
        updateError: { code: '23514', message: 'check constraint violated' },
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          exitDate: '2026-10-10',
        }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'EMPLOYMENT_RECORD_CHANGED' });
      expect(String(body['message'])).toContain('changed since it was read');
    });
  });

  describe('UpdateEmploymentDto — the pipe-level shapes', () => {
    const validateBody = async (body: Record<string, unknown>) => {
      const dto = plainToInstance(UpdateEmploymentDto, body);
      return validate(dto, { whitelist: true });
    };

    it('takes the full Form V save, and a null as the clear verb', async () => {
      const errors = await validateBody({
        ...fullFormV,
      });
      expect(errors).toHaveLength(0);
      expect(await validateBody({ pan: null, joinDate: null })).toHaveLength(0);
    });

    it('rejects a malformed PAN in plain English, never echoing the value', async () => {
      const errors = await validateBody({ pan: '12bcd345g' });
      expect(errors).toHaveLength(1);
      const message = Object.values(
        errors[0].constraints as Record<string, string>,
      )[0];
      expect(message).toContain('pan');
      expect(message).not.toContain('12bcd345g');
    });

    it('rejects a malformed IFSC', async () => {
      const errors = await validateBody({ ifscCode: 'HDFC12XY34' });
      expect(errors).toHaveLength(1);
      expect(JSON.stringify(errors[0].constraints)).toContain('ifscCode');
    });

    it('rejects a badly shaped date but passes a real one for the service to calendar-check', async () => {
      expect(await validateBody({ joinDate: '01/09/2026' })).toHaveLength(1);
      expect(await validateBody({ joinDate: '2026-02-30' })).toHaveLength(0);
    });

    it('trims text before validation, so a padded PAN still passes the shape', async () => {
      expect(await validateBody({ pan: '  ABCPE1234F  ' })).toHaveLength(0);
    });
  });
});
