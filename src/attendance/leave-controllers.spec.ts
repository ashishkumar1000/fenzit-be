import 'reflect-metadata';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { MeLeaveController } from './me-leave.controller';
import { LeaveController } from './leave.controller';
import { Role } from '../common/enums/role.enum';

// Nest role metadata key (the house mirror — me-attendance.controller.spec).
const ROLES_KEY = 'roles';

/**
 * Route wiring pins for the leave controllers (17-1..17-4). The 16-1
 * review caught a CRITICAL here: a missing `@Body()` made the dto arrive
 * `undefined` over HTTP while every direct-call test passed — the routes
 * were dead at the wire level. The pins use the same metadata shapes as
 * me-attendance.controller.spec: the argument map lives on the CLASS,
 * keyed `"<RouteParamtypes>:<index>"`, and a body without its decorator
 * simply has no entry.
 */

// Nest route metadata key (the same house mirror
// me-attendance.controller.spec uses — imported enum, never literals).
const ROUTE_ARGS_METADATA = '__routeArguments__';

type ArgMap = Record<string, { index: number } | undefined>;

function argsOf(target: object, handler: string): ArgMap {
  return (Reflect.getMetadata(ROUTE_ARGS_METADATA, target, handler) ??
    {}) as ArgMap;
}

function keyOf(type: RouteParamtypes, index: number): string {
  return `${type}:${index}`;
}

/** The body-bound parameter at `index` — undefined when @Body() is missing. */
function bodyArgAt(target: object, handler: string, index: number): boolean {
  return (
    argsOf(target, handler)[keyOf(RouteParamtypes.BODY, index)] !== undefined
  );
}

function headerArgAt(target: object, handler: string, index: number): boolean {
  return (
    argsOf(target, handler)[keyOf(RouteParamtypes.HEADERS, index)] !== undefined
  );
}

function queryArgAt(target: object, handler: string, index: number): boolean {
  return (
    argsOf(target, handler)[keyOf(RouteParamtypes.QUERY, index)] !== undefined
  );
}

function paramArgAt(target: object, handler: string, index: number): boolean {
  return (
    argsOf(target, handler)[keyOf(RouteParamtypes.PARAM, index)] !== undefined
  );
}

describe('MeLeaveController route pins (technician)', () => {
  it('POST apply binds its body with @Body() at index 2 — an undecorated parameter arrives undefined over HTTP (the 16-1 CRITICAL class)', () => {
    expect(bodyArgAt(MeLeaveController, 'apply', 2)).toBe(true);
    expect(headerArgAt(MeLeaveController, 'apply', 1)).toBe(true); // (user, idempotencyKey, dto)
  });

  it('previewApply takes the query; cancel takes the :id param and NO body', () => {
    expect(queryArgAt(MeLeaveController, 'previewApply', 1)).toBe(true);
    expect(paramArgAt(MeLeaveController, 'cancel', 1)).toBe(true);
    expect(bodyArgAt(MeLeaveController, 'cancel', 1)).toBe(false);
  });

  it('listMine takes the query', () => {
    expect(queryArgAt(MeLeaveController, 'list', 1)).toBe(true);
  });
});

describe('LeaveController route pins (owner)', () => {
  it('reject and revoke bind their bodies at index 2 after the :id param', () => {
    for (const handler of ['reject', 'revoke'] as const) {
      expect(paramArgAt(LeaveController, handler, 1)).toBe(true);
      expect(bodyArgAt(LeaveController, handler, 2)).toBe(true);
    }
  });

  it('on-behalf requires the idempotency header (AD-6) and a body', () => {
    expect(headerArgAt(LeaveController, 'applyOnBehalf', 1)).toBe(true);
    expect(bodyArgAt(LeaveController, 'applyOnBehalf', 2)).toBe(true);
  });

  it('approve takes neither header nor body (state-guarded, not keyed)', () => {
    expect(paramArgAt(LeaveController, 'approve', 1)).toBe(true);
    expect(headerArgAt(LeaveController, 'approve', 1)).toBe(false);
    expect(bodyArgAt(LeaveController, 'approve', 2)).toBe(false);
  });

  it('the owner list takes the query (status/employeeId/cursor)', () => {
    expect(queryArgAt(LeaveController, 'list', 1)).toBe(true);
  });
});

describe('role guard pins (spec §7)', () => {
  it('every me/leave handler is TECHNICIAN-only', () => {
    for (const handler of ['previewApply', 'apply', 'list', 'previewCancel', 'cancel']) {
      const roles = Reflect.getMetadata(ROLES_KEY, MeLeaveController.prototype[handler] as object);
      expect(roles).toEqual([Role.TECHNICIAN]);
    }
  });

  it('the owner controller is OWNER-only at CLASS level — a technician must never approve, revoke or apply on behalf', () => {
    // @Roles(Role.OWNER) sits on the LeaveController class — one guard for
    // every handler, pinned at the class.
    const roles = Reflect.getMetadata(ROLES_KEY, LeaveController);
    expect(roles).toEqual([Role.OWNER]);
  });
});
