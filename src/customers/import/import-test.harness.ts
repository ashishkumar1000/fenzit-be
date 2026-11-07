import { Test } from '@nestjs/testing';
import { ImportController } from './import.controller';
import { ImportValidateService } from './import-validate.service';
import { ImportCommitService } from './import-commit.service';
import { FakeDb } from './import-test.fake-db';
import { SupabaseClientFactory } from '../../common/factories/supabase-client.factory';
import { CountryCodesService } from '../../country-codes/country-codes.service';
import { RequestUser } from '../../common/interfaces/request-user.interface';
import { Role } from '../../common/enums/role.enum';

/** Test-only harness (not a spec file). Builds the real controller and services on the fake DB. */

export const COMPANY_A = '11111111-aaaa-4aaa-8aaa-111111111111';
export const COMPANY_B = '22222222-bbbb-4bbb-8bbb-222222222222';
export const STAFF_ID = '33333333-cccc-4ccc-8ccc-333333333333';
export const DIAL_CODES = ['+91', '+1', '+1242', '+44', '+971'];

/** Fenzit staff acting on `tenantId` (null = no X-Company-Id header sent). */
export const staffUser = (
  tenantId: string | null = COMPANY_A,
): RequestUser => ({
  userId: STAFF_ID,
  tenantId,
  role: Role.PLATFORM_ADMIN,
  platformAdmin: true,
  rawJwt: 'jwt',
});

export interface Harness {
  db: FakeDb;
  controller: ImportController;
  validate: ImportValidateService;
  commit: ImportCommitService;
  countryCodesList: jest.Mock;
}

export async function createHarness(): Promise<Harness> {
  const db = new FakeDb();
  const countryCodesList = jest.fn(async () =>
    DIAL_CODES.map((dialCode) => ({
      dialCode,
      countryName: dialCode,
      iso2: 'XX',
    })),
  );
  const factory = {
    createAdmin: () => db.client(),
    createPublic: () => db.client(),
  };
  const module = await Test.createTestingModule({
    controllers: [ImportController],
    providers: [
      ImportValidateService,
      ImportCommitService,
      { provide: SupabaseClientFactory, useValue: factory },
      { provide: CountryCodesService, useValue: { list: countryCodesList } },
    ],
  }).compile();
  return {
    db,
    controller: module.get(ImportController),
    validate: module.get(ImportValidateService),
    commit: module.get(ImportCommitService),
    countryCodesList,
  };
}

/** A row that passes every check with a default country of +91. */
export const goodRow = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: 'Asha Verma',
  address: '12 MG Road',
  phone: '9876543210',
  latitude: 12.9716,
  longitude: 77.5946,
  ...overrides,
});

export const IDEMPOTENCY_KEY = 'import-key-0001';
