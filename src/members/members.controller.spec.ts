import { CAN_KEY } from '../common/decorators/can.decorator';
import { ANY_MEMBER_KEY } from '../common/decorators/any-member.decorator';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';

/**
 * The permission each handler needs. A route that loses its @Can would open to
 * every signed-in person, so the table is the requirement, not the decorators.
 */
const REQUIRED: Record<string, string[]> = {
  list: ['member.read'],
  changeRole: ['member.change_role'],
  remove: ['member.remove'],
  disable: ['user.disable'],
  enable: ['user.disable'],
  auditLog: ['audit.read'],
};

const caller: RequestUser = {
  userId: 'admin-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

describe('MembersController', () => {
  const handlers = Object.getOwnPropertyNames(MembersController.prototype).filter(
    (name) => name !== 'constructor',
  );

  it('lists the handlers this spec knows, so a new route cannot skip the table', () => {
    expect(handlers.sort()).toEqual(Object.keys(REQUIRED).sort());
  });

  it.each(Object.entries(REQUIRED))(
    '%s needs exactly the permissions the requirement names',
    (name, permissions) => {
      const handler = MembersController.prototype[name as keyof MembersController];
      expect(Reflect.getMetadata(CAN_KEY, handler)).toEqual(permissions);
    },
  );

  it.each(handlers)('%s is never open to every signed-in person', (name) => {
    const handler = MembersController.prototype[name as keyof MembersController];
    expect(Reflect.getMetadata(ANY_MEMBER_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBeDefined();
  });

  it('passes the caller, not a client-chosen company, to the service on list', async () => {
    const service = { list: jest.fn().mockResolvedValue([]) };
    const controller = new MembersController(service as unknown as MembersService);
    await controller.list(caller);
    expect(service.list).toHaveBeenCalledWith(caller);
  });

  it('turns a disable into a disable, and an enable into an enable', async () => {
    const service = {
      setDisabled: jest.fn().mockResolvedValue({ userId: 'p', disabled: true }),
    };
    const controller = new MembersController(service as unknown as MembersService);
    await controller.disable(caller, 'p');
    expect(service.setDisabled).toHaveBeenLastCalledWith(caller, 'p', true);
    await controller.enable(caller, 'p');
    expect(service.setDisabled).toHaveBeenLastCalledWith(caller, 'p', false);
  });
});
