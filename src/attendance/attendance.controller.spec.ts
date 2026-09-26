import 'reflect-metadata';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { SetupStateResponse } from './attendance-response.model';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

// Nest route metadata keys (mirror of @nestjs/common/constants — imported
// values, not literals, per reports.controller.spec.ts's reflection style).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const HTTP_CODE_METADATA = '__httpCode__';

const state: SetupStateResponse = {
  started: true,
  currentStep: 'timings',
  setupCompletedAt: null,
  enabled: false,
};

describe('AttendanceController — setup routes (story 15-2)', () => {
  const user: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  function controllerWith(service: Partial<AttendanceService>) {
    return new AttendanceController(service as unknown as AttendanceService);
  }

  // A passthrough reply — the start route sets the status code on it, every
  // other route leaves it untouched.
  function reply() {
    const code = jest.fn().mockReturnThis();
    return { code };
  }

  describe('delegation', () => {
    it('getSetupState passes the current user straight through', async () => {
      const getSetupState = jest.fn().mockResolvedValue(state);
      const controller = controllerWith({ getSetupState });

      await expect(controller.getSetupState(user)).resolves.toBe(state);
      expect(getSetupState).toHaveBeenCalledWith(user);
    });

    it('saveStep passes the current user and the parsed body dto', async () => {
      const dto = { currentStep: 'timings' } as const;
      const saveStep = jest.fn().mockResolvedValue(undefined);
      const controller = controllerWith({ saveStep });

      await expect(controller.saveStep(user, dto as never)).resolves.toBe(
        undefined,
      );
      expect(saveStep).toHaveBeenCalledWith(user, dto);
    });

    it('completeSetup passes the current user straight through', async () => {
      const completeSetup = jest.fn().mockResolvedValue(state);
      const controller = controllerWith({ completeSetup });

      await expect(controller.completeSetup(user)).resolves.toBe(state);
      expect(completeSetup).toHaveBeenCalledWith(user);
    });
  });

  describe('start route — dynamic 201/200', () => {
    it('returns the state and codes 201 on first start', async () => {
      const startSetup = jest
        .fn()
        .mockResolvedValue({ state, created: true });
      const controller = controllerWith({ startSetup });
      const r = reply();

      await expect(controller.startSetup(user, r as never)).resolves.toBe(state);
      expect(startSetup).toHaveBeenCalledWith(user);
      expect(r.code).toHaveBeenCalledWith(201);
    });

    it('codes 200 when the wizard was already under way (resume)', async () => {
      const startSetup = jest
        .fn()
        .mockResolvedValue({ state, created: false });
      const controller = controllerWith({ startSetup });
      const r = reply();

      await expect(controller.startSetup(user, r as never)).resolves.toBe(state);
      expect(r.code).toHaveBeenCalledWith(200);
    });
  });

  describe('route metadata', () => {
    it('is mounted at attendance/setup', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AttendanceController)).toBe(
        'attendance/setup',
      );
    });

    it.each([
      ['getSetupState', '/', 0], // 0 = RequestMethod.GET
      ['startSetup', '/', 1], // 1 = RequestMethod.POST
      ['saveStep', '/', 4], // 4 = RequestMethod.PATCH
      ['completeSetup', 'complete', 1],
    ])(
      '%s is wired as %s',
      (handler: keyof AttendanceController, path: string, method: number) => {
        const meta = Reflect.getMetadata(
          METHOD_METADATA,
          AttendanceController.prototype[handler] as object,
        );
        expect(Reflect.getMetadata(
          PATH_METADATA,
          AttendanceController.prototype[handler] as object,
        )).toBe(path);
        expect(meta).toBe(method);
      },
    );

    it.each(['getSetupState', 'startSetup', 'saveStep', 'completeSetup'])(
      '%s is owner-only — a technician must never reach the setup wizard',
      (handler: keyof AttendanceController) => {
        const roles = Reflect.getMetadata(
          ROLES_KEY,
          AttendanceController.prototype[handler] as object,
        ) as Role[] | undefined;

        expect(roles).toEqual([Role.OWNER]);
      },
    );

    it.each([
      ['getSetupState', 200],
      ['saveStep', 200],
      ['completeSetup', 200],
    ])('%s carries a fixed @HttpCode(%i)', (handler: keyof AttendanceController, code: number) => {
      expect(
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          AttendanceController.prototype[handler] as object,
        ),
      ).toBe(code);
    });

    it('startSetup carries the declared 201 (the live status is set per-response from `created`)', () => {
      // The swagger/documented default is 201; the passthrough reply narrows
      // it to 200 on resume — both behaviours are pinned by the unit tests
      // above, this pins that no future refactor drops the decorator silently.
      expect(
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          AttendanceController.prototype.startSetup as object,
        ),
      ).toBe(201);
    });
  });
});