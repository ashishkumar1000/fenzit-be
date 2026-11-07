import 'reflect-metadata';
import {
  ArgumentMetadata,
  ExecutionContext,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ImportController } from './import.controller';
import { ValidateImportRowsDto } from './dto/validate-import-rows.dto';
import { CommitImportRowsDto } from './dto/commit-import-rows.dto';
import { IMPORT_MAX_ROWS } from './import-rows.types';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CAN_KEY } from '../../common/decorators/can.decorator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe-options';
import { RequestUser } from '../../common/interfaces/request-user.interface';
import { Role } from '../../common/enums/role.enum';
import {
  createHarness,
  goodRow,
  staffUser,
  COMPANY_A,
  Harness,
  IDEMPOTENCY_KEY,
} from './import-test.harness';

/** QA: the HTTP contract of both import routes (body bounds, key, staff-only, company). */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const bodyMeta = (metatype: unknown): ArgumentMetadata => ({
  type: 'body',
  metatype: metatype as never,
  data: '',
});

async function accepted<T>(metatype: unknown, value: unknown): Promise<T> {
  return (await pipe.transform(value, bodyMeta(metatype))) as T;
}
async function refused(metatype: unknown, value: unknown): Promise<void> {
  await expect(pipe.transform(value, bodyMeta(metatype))).rejects.toMatchObject(
    { status: 422 },
  );
}

const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `N${i}`,
    phone: `9${String(100000000 + i)}`,
  }));

describe('import HTTP contract (QA)', () => {
  describe('row count bounds (1 to 500 rows)', () => {
    it('refuses an empty sheet with 422', async () => {
      await refused(ValidateImportRowsDto, { rows: [] });
    });

    it('accepts one row (lower boundary)', async () => {
      await expect(
        accepted(ValidateImportRowsDto, { rows: rowsOf(1) }),
      ).resolves.toMatchObject({ rows: expect.any(Array) });
    });

    it('accepts exactly 500 rows (upper boundary)', async () => {
      const dto = await accepted<ValidateImportRowsDto>(ValidateImportRowsDto, {
        rows: rowsOf(IMPORT_MAX_ROWS),
      });
      expect(dto.rows).toHaveLength(500);
    });

    it('refuses 501 rows with 422', async () => {
      await refused(ValidateImportRowsDto, {
        rows: rowsOf(IMPORT_MAX_ROWS + 1),
      });
    });

    it('applies the same bounds on the commit route', async () => {
      await refused(CommitImportRowsDto, { rows: rowsOf(501) });
      await refused(CommitImportRowsDto, { rows: [] });
    });

    it.each([
      ['a missing rows key', {}],
      ['rows as an object', { rows: { name: 'x' } }],
      ['rows as a string', { rows: 'name,phone' }],
      ['rows as null', { rows: null }],
    ])('refuses %s with 422', async (_label, body) => {
      await refused(ValidateImportRowsDto, body);
    });

    it('lets row items of any type through to per-row checks (a bad row is a row reason, not a 422)', async () => {
      const dto = await accepted<ValidateImportRowsDto>(ValidateImportRowsDto, {
        rows: [1, 'x', null, goodRow()],
      });
      expect(dto.rows).toHaveLength(4);
    });
  });

  describe('defaultCountryCode (optional dial code, e.g. +91)', () => {
    it.each([
      ['+91', '+91'],
      ['+1', '+1'],
      ['+1242', '+1242'],
      ['  +91  ', '+91'],
    ])('accepts %j and keeps %j', async (code, kept) => {
      const dto = await accepted<ValidateImportRowsDto>(ValidateImportRowsDto, {
        rows: rowsOf(1),
        defaultCountryCode: code,
      });
      expect(dto.defaultCountryCode).toBe(kept);
    });

    it.each([
      ['no plus sign', '91'],
      ['letters', '+91a'],
      ['five digits', '+12345'],
      ['a space inside', '+9 1'],
      ['a number instead of text', 91],
    ])('refuses %s with 422', async (_label, code) => {
      await refused(ValidateImportRowsDto, {
        rows: rowsOf(1),
        defaultCountryCode: code,
      });
    });

    it.each([
      ['an empty string', ''],
      ['spaces only', '   '],
    ])('treats %s as no country picked', async (_label, code) => {
      const dto = await accepted<ValidateImportRowsDto>(ValidateImportRowsDto, {
        rows: rowsOf(1),
        defaultCountryCode: code,
      });
      expect(dto.defaultCountryCode).toBeUndefined();
    });
  });

  describe('commit file name (optional, up to 255)', () => {
    it('accepts 255 characters and refuses 256', async () => {
      await expect(
        accepted(CommitImportRowsDto, {
          rows: rowsOf(1),
          fileName: 'f'.repeat(255),
        }),
      ).resolves.toBeDefined();
      await refused(CommitImportRowsDto, {
        rows: rowsOf(1),
        fileName: 'f'.repeat(256),
      });
    });

    it('treats a blank file name as absent', async () => {
      const dto = await accepted<CommitImportRowsDto>(CommitImportRowsDto, {
        rows: rowsOf(1),
        fileName: '   ',
      });
      expect(dto.fileName).toBeUndefined();
    });

    it('refuses a numeric file name', async () => {
      await refused(CommitImportRowsDto, { rows: rowsOf(1), fileName: 12 });
    });
  });

  describe('X-Idempotency-Key on commit (1 to 128 characters, no spaces)', () => {
    let h: Harness;
    let commitSpy: jest.SpyInstance;
    const dto = { rows: [goodRow()] } as CommitImportRowsDto;

    beforeEach(async () => {
      h = await createHarness();
      commitSpy = jest.spyOn(h.commit, 'commit').mockResolvedValue({
        batchId: 'b',
        rows: [],
        summary: { total: 0, created: 0, updated: 0, failed: 0 },
      });
    });

    it.each([
      ['a missing header', undefined],
      ['an empty header', ''],
      ['spaces only', '   '],
      ['a key with a space inside', 'abc def'],
      ['a key with a tab inside', 'abc\tdef'],
      ['a key with a leading space', ' abc'],
      ['a key of 129 characters', 'k'.repeat(129)],
    ])('refuses %s with 422 and never starts the import', (_label, key) => {
      let status: number | undefined;
      try {
        h.controller.commit(staffUser(COMPANY_A), key, dto);
      } catch (error) {
        status = (error as { getStatus: () => number }).getStatus();
      }
      expect(status).toBe(422);
      expect(commitSpy).not.toHaveBeenCalled();
      expect(h.db.calls).toEqual([]);
    });

    it('returns 422 with a VALIDATION_ERROR body for a missing key', () => {
      try {
        h.controller.commit(staffUser(COMPANY_A), undefined, dto);
        throw new Error('expected a 422');
      } catch (error) {
        expect((error as { getStatus: () => number }).getStatus()).toBe(422);
        expect(
          (error as { getResponse: () => unknown }).getResponse(),
        ).toMatchObject({
          error_code: 'VALIDATION_ERROR',
        });
      }
    });

    it('accepts a key of exactly 1 character', () => {
      h.controller.commit(staffUser(COMPANY_A), 'k', dto);
      expect(commitSpy).toHaveBeenCalledWith(expect.anything(), dto, 'k');
    });

    it('accepts a key of exactly 128 characters (upper boundary)', () => {
      const key = 'k'.repeat(128);
      h.controller.commit(staffUser(COMPANY_A), key, dto);
      expect(commitSpy).toHaveBeenCalledWith(expect.anything(), dto, key);
    });

    it('accepts a key with non-ASCII characters within the limit', () => {
      h.controller.commit(staffUser(COMPANY_A), 'ключ-0001', dto);
      expect(commitSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('staff only (user.manage, real guard, real decorator metadata)', () => {
    const guard = new PermissionsGuard(new Reflector());
    const decide = (
      handler: (...args: never[]) => unknown,
      user: RequestUser | undefined,
    ): 'allow' | 'deny' => {
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
        getHandler: () => handler,
        getClass: () => ImportController,
      } as unknown as ExecutionContext;
      try {
        return guard.canActivate(ctx) ? 'allow' : 'deny';
      } catch {
        return 'deny';
      }
    };
    const userWith = (
      role: Role | null,
      tenantId: string | null = COMPANY_A,
    ): RequestUser => ({
      userId: '44444444-dddd-4ddd-8ddd-444444444444',
      tenantId: role === null ? null : tenantId,
      role,
      platformAdmin: role === Role.PLATFORM_ADMIN,
      rawJwt: 'jwt',
    });

    it.each([
      ['validate', ImportController.prototype.validate],
      ['commit', ImportController.prototype.commit],
    ])('the %s route declares exactly user.manage', (_name, handler) => {
      expect(Reflect.getMetadata(CAN_KEY, handler)).toEqual(['user.manage']);
    });

    it.each([
      ['validate', ImportController.prototype.validate],
      ['commit', ImportController.prototype.commit],
    ])('%s: staff with a company is allowed', (_name, handler) => {
      expect(decide(handler as never, userWith(Role.PLATFORM_ADMIN))).toBe(
        'allow',
      );
    });

    it.each([
      ['validate', ImportController.prototype.validate],
      ['commit', ImportController.prototype.commit],
    ])(
      '%s: a company owner gets 403 even with their own company',
      (_name, handler) => {
        expect(decide(handler as never, userWith(Role.COMPANY_ADMIN))).toBe(
          'deny',
        );
      },
    );

    it.each([
      ['an employee', Role.EMPLOYEE],
      ['a viewer', Role.VIEWER],
      ['a person with no membership', null],
    ])('refuses %s', (_label, role) => {
      expect(decide(ImportController.prototype.validate, userWith(role))).toBe(
        'deny',
      );
      expect(decide(ImportController.prototype.commit, userWith(role))).toBe(
        'deny',
      );
    });

    it('answers a company owner with 403 FORBIDDEN on both routes (the exception itself, not a bool)', () => {
      for (const handler of [
        ImportController.prototype.validate,
        ImportController.prototype.commit,
      ]) {
        const ctx = {
          switchToHttp: () => ({
            getRequest: () => ({ user: userWith(Role.COMPANY_ADMIN) }),
          }),
          getHandler: () => handler,
          getClass: () => ImportController,
        } as unknown as ExecutionContext;
        expect(() => guard.canActivate(ctx)).toThrow();
        try {
          guard.canActivate(ctx);
        } catch (error) {
          expect(error).toMatchObject({
            status: 403,
            response: { error_code: 'FORBIDDEN' },
          });
        }
      }
    });

    it('refuses a request with no authenticated user at all', () => {
      expect(decide(ImportController.prototype.commit, undefined)).toBe('deny');
    });

    it('lets staff with no X-Company-Id through the guard, so the service answers 400 (documented)', async () => {
      expect(
        decide(
          ImportController.prototype.validate,
          userWith(Role.PLATFORM_ADMIN, null),
        ),
      ).toBe('allow');
      const h = await createHarness();
      await expect(
        h.validate.validate(staffUser(null), { rows: [goodRow()] }),
      ).rejects.toMatchObject({
        status: 400,
      });
      expect(h.db.calls).toEqual([]);
    });
  });
});
