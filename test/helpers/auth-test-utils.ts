import { TestingModuleBuilder } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { MembershipResolver } from '../../src/common/auth/membership-resolver';
import type { ResolvedAccess } from '../../src/common/auth/membership-resolver';
import { MembershipRole } from '../../src/common/enums/role.enum';

/**
 * Test support for the roles work. A login token carries identity only
 * (`sub` + `typ: 'access'`); company and role are read from the database per
 * request by `MembershipResolver`. Mocked-database suites therefore replace
 * the resolver with a fake keyed by user id.
 */

export interface FakePerson {
  userId: string;
  /** Omit (or null) for a person with no active company membership. */
  tenantId?: string | null;
  role?: MembershipRole | null;
  platformAdmin?: boolean;
  disabled?: boolean;
}

/** A login token the guard accepts (identity + the `typ: 'access'` marker). */
export function accessToken(jwt: JwtService, userId: string): string {
  return jwt.sign({ sub: userId, typ: 'access' });
}

/** A MembershipResolver stand-in over a fixed list of people. */
export function fakeMembershipResolver(
  people: FakePerson[],
  existingCompanies: string[] = [],
): Pick<MembershipResolver, 'resolve' | 'companyExists'> {
  const byId = new Map(people.map((p) => [p.userId, p]));
  const companies = new Set([
    ...existingCompanies,
    ...people.map((p) => p.tenantId).filter((t): t is string => !!t),
  ]);
  return {
    resolve: (userId: string): Promise<ResolvedAccess | null> => {
      const p = byId.get(userId);
      if (!p) return Promise.resolve(null);
      return Promise.resolve({
        userId: p.userId,
        platformAdmin: p.platformAdmin ?? false,
        disabled: p.disabled ?? false,
        membership:
          p.tenantId && p.role
            ? { tenantId: p.tenantId, role: p.role }
            : null,
      });
    },
    companyExists: (tenantId: string) =>
      Promise.resolve(companies.has(tenantId)),
  };
}

/** `builder.overrideProvider(MembershipResolver)` with a fake over `people`. */
export function withPeople(
  builder: TestingModuleBuilder,
  people: FakePerson[],
  existingCompanies: string[] = [],
): TestingModuleBuilder {
  return builder
    .overrideProvider(MembershipResolver)
    .useValue(fakeMembershipResolver(people, existingCompanies));
}
