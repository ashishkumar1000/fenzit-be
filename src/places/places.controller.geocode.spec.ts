import 'reflect-metadata';
import { ExecutionContext, RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PATH_METADATA,
  METHOD_METADATA,
  HTTP_CODE_METADATA,
} from '@nestjs/common/constants';
import { PlacesController } from './places.controller';
import { PlacesService } from './places.service';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { CAN_KEY } from '../common/decorators/can.decorator';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';

const handler = PlacesController.prototype.geocode;

/**
 * Runs the REAL PermissionsGuard with the REAL Reflector against the
 * geocode handler's own decorator metadata, so these tests fail if someone
 * changes or removes the @Can('user.manage') on the route.
 */
function guardDecision(user: RequestUser | undefined): 'allow' | 'deny' {
  const guard = new PermissionsGuard(new Reflector());
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => PlacesController,
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx) ? 'allow' : 'deny';
  } catch {
    return 'deny';
  }
}

const userWith = (role: Role | null): RequestUser => ({
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: role === null ? null : '22222222-2222-4222-8222-222222222222',
  role,
  platformAdmin: role === Role.PLATFORM_ADMIN,
  rawJwt: 'jwt',
});

describe('PlacesController GET /places/geocode (QA)', () => {
  describe('route metadata', () => {
    it('should be served as GET on the path geocode', () => {
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('geocode');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.GET,
      );
    });

    it('should return 200 on success', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    });

    it('should require exactly the user.manage permission (staff only)', () => {
      expect(Reflect.getMetadata(CAN_KEY, handler)).toEqual(['user.manage']);
    });

    it('should not be marked public or any-member, so the guard cannot be bypassed by a stray decorator', () => {
      const reflector = new Reflector();
      expect(reflector.get('isPublic', handler)).toBeUndefined();
      expect(reflector.get('anyMember', handler)).toBeUndefined();
    });
  });

  describe('who may call it (real guard decision)', () => {
    it('should allow a PLATFORM_ADMIN (staff) user', () => {
      expect(guardDecision(userWith(Role.PLATFORM_ADMIN))).toBe('allow');
    });

    it('should refuse a COMPANY_ADMIN (owner) even though they hold places.search', () => {
      expect(guardDecision(userWith(Role.COMPANY_ADMIN))).toBe('deny');
    });

    it('should refuse an EMPLOYEE', () => {
      expect(guardDecision(userWith(Role.EMPLOYEE))).toBe('deny');
    });

    it('should refuse a VIEWER', () => {
      expect(guardDecision(userWith(Role.VIEWER))).toBe('deny');
    });

    it('should refuse a signed-in person with no company membership (null role)', () => {
      expect(guardDecision(userWith(null))).toBe('deny');
    });

    it('should refuse a request with no authenticated user at all', () => {
      expect(guardDecision(undefined)).toBe('deny');
    });
  });

  describe('delegation', () => {
    it('should pass the caller and the already-validated address parts to the service', async () => {
      const geocodeAddress = jest.fn().mockResolvedValue({
        formattedAddress: null,
        latitude: null,
        longitude: null,
      });
      const controller = new PlacesController({
        geocodeAddress,
      } as unknown as PlacesService);
      const staff = userWith(Role.PLATFORM_ADMIN);

      await controller.geocode(staff, { address: 'MG Road, Bengaluru' });

      expect(geocodeAddress).toHaveBeenCalledWith(staff, {
        address: 'MG Road, Bengaluru',
        city: undefined,
        state: undefined,
        pincode: undefined,
      });
    });
  });
});
