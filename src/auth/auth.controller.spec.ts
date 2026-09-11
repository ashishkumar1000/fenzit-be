import 'reflect-metadata';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

describe('AuthController — realtime-token route', () => {
  const user: RequestUser = {
    userId: '550e8400-e29b-41d4-a716-446655440000',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'login-jwt',
  };

  it('delegates to AuthService.mintRealtimeToken and returns its result', async () => {
    const minted = {
      token: 'realtime-jwt',
      expiresAt: '2026-09-09T20:00:00.000Z',
    };
    const authService = {
      mintRealtimeToken: jest.fn().mockResolvedValue(minted),
    } as unknown as AuthService;

    const controller = new AuthController(authService);

    await expect(controller.realtimeToken(user)).resolves.toBe(minted);
    expect(authService.mintRealtimeToken).toHaveBeenCalledWith(user);
  });

  it('is owner-only — the mint route must never accept a Realtime token back (self-renewal)', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      AuthController.prototype.realtimeToken,
    ) as Role[] | undefined;

    expect(roles).toEqual([Role.OWNER]);
  });
});
