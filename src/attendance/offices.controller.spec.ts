import 'reflect-metadata';
import { OfficesController } from './offices.controller';
import { OfficesService } from './offices.service';
import { OfficeDetailResponse, OfficeResponse } from './offices-response.model';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

// Nest route metadata keys (mirror of @nestjs/common/constants values).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const HTTP_CODE_METADATA = '__httpCode__';

const office: OfficeResponse = {
  id: '00000000-0000-4000-8000-0000000000e1',
  name: 'Andheri West',
  latitude: 19.1364,
  longitude: 72.8296,
  radiusM: 100,
  archivedAt: null,
  rule: null,
  nextRule: null,
};

const detail: OfficeDetailResponse = { ...office, rules: [] };

describe('OfficesController (story 15-3)', () => {
  const user: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  function controllerWith(service: Partial<OfficesService>) {
    return new OfficesController(service as unknown as OfficesService);
  }

  describe('delegation', () => {
    it('listOffices passes the user and the parsed includeArchived flag', async () => {
      const listOffices = jest.fn().mockResolvedValue([office]);
      const controller = controllerWith({ listOffices });

      await expect(controller.listOffices(user, { includeArchived: 'true' })).resolves.toEqual([
        office,
      ]);
      expect(listOffices).toHaveBeenCalledWith(user, true);
    });

    it('listOffices defaults includeArchived to false', async () => {
      const listOffices = jest.fn().mockResolvedValue([]);
      const controller = controllerWith({ listOffices });

      await controller.listOffices(user, {});
      expect(listOffices).toHaveBeenCalledWith(user, false);
    });

    it('getOffice passes the user and the route param', async () => {
      const getOffice = jest.fn().mockResolvedValue(detail);
      const controller = controllerWith({ getOffice });

      await expect(controller.getOffice(user, '00000000-0000-4000-8000-0000000000e1')).resolves.toBe(detail);
      expect(getOffice).toHaveBeenCalledWith(user, '00000000-0000-4000-8000-0000000000e1');
    });

    it('createOffice passes the user and the parsed dto', async () => {
      const createOffice = jest.fn().mockResolvedValue(office);
      const controller = controllerWith({ createOffice });
      const dto = { name: 'Andheri West', startTime: '10:00' };

      await expect(controller.createOffice(user, dto as never)).resolves.toBe(office);
      expect(createOffice).toHaveBeenCalledWith(user, dto);
    });

    it('updateOffice passes the user, the param and the parsed dto', async () => {
      const updateOffice = jest.fn().mockResolvedValue(detail);
      const controller = controllerWith({ updateOffice });
      const dto = { radiusM: 200 };

      await expect(controller.updateOffice(user, '00000000-0000-4000-8000-0000000000e1', dto as never)).resolves.toBe(detail);
      expect(updateOffice).toHaveBeenCalledWith(user, '00000000-0000-4000-8000-0000000000e1', dto);
    });

    it('archiveOffice passes the user and the param, resolving to nothing (204 body)', async () => {
      const archiveOffice = jest.fn().mockResolvedValue(null);
      const controller = controllerWith({ archiveOffice });

      await expect(controller.archiveOffice(user, '00000000-0000-4000-8000-0000000000e1')).resolves.toBeUndefined();
      expect(archiveOffice).toHaveBeenCalledWith(user, '00000000-0000-4000-8000-0000000000e1');
    });

    it('getArchiveBlockers passes the user and the param', async () => {
      const getArchiveBlockers = jest
        .fn()
        .mockResolvedValue({ officeId: '00000000-0000-4000-8000-0000000000e1', blockers: [] });
      const controller = controllerWith({ getArchiveBlockers });

      await expect(controller.getArchiveBlockers(user, '00000000-0000-4000-8000-0000000000e1')).resolves.toEqual({
        officeId: '00000000-0000-4000-8000-0000000000e1',
        blockers: [],
      });
      expect(getArchiveBlockers).toHaveBeenCalledWith(user, '00000000-0000-4000-8000-0000000000e1');
    });
  });

  describe('route metadata', () => {
    it('is mounted at attendance/offices', () => {
      expect(Reflect.getMetadata(PATH_METADATA, OfficesController)).toBe('attendance/offices');
    });

    it.each([
      // 0 = RequestMethod.GET, 1 = POST, 4 = PATCH
      ['listOffices', '/', 0],
      ['getOffice', ':id', 0],
      ['createOffice', '/', 1],
      ['updateOffice', ':id', 4],
      ['archiveOffice', ':id/archive', 1],
      ['getArchiveBlockers', ':id/archive/preview', 0],
    ])(
      '%s is wired as %s',
      (handler: keyof OfficesController, path: string, method: number) => {
        const proto = OfficesController.prototype[handler] as object;
        expect(Reflect.getMetadata(PATH_METADATA, proto)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, proto)).toBe(method);
      },
    );

    it.each([
      'listOffices',
      'getOffice',
      'createOffice',
      'updateOffice',
      'archiveOffice',
      'getArchiveBlockers',
    ])(
      '%s is owner-only — office management never opens to a technician',
      (handler: keyof OfficesController) => {
        const roles = Reflect.getMetadata(
          ROLES_KEY,
          OfficesController.prototype[handler] as object,
        ) as Role[] | undefined;

        expect(roles).toEqual([Role.OWNER]);
      },
    );

    it.each([
      ['listOffices', 200],
      ['getOffice', 200],
      ['createOffice', 201],
      ['updateOffice', 200],
      ['archiveOffice', 204],
      ['getArchiveBlockers', 200],
    ])('%s carries a fixed @HttpCode(%i)', (handler: keyof OfficesController, code: number) => {
      expect(
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          OfficesController.prototype[handler] as object,
        ),
      ).toBe(code);
    });
  });
});
