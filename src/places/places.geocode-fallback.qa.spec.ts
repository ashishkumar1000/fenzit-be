import { ConfigService } from '@nestjs/config';
import { PlacesService } from './places.service';
import { PlacesProvider, ForwardGeocodedPlace } from './places-provider';
import { PlacesRateLimitStore } from './places-rate-limit.store';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';

/**
 * QA for the staff forward lookup: the name is sent first, a street-and-state
 * retry runs only when the first query finds nothing, and the match's address
 * parts and the approximate flag come back to the screen.
 */
const staff: RequestUser = {
  userId: '55555555-eeee-4eee-8eee-555555555555',
  tenantId: '66666666-ffff-4fff-8fff-666666666666',
  role: Role.PLATFORM_ADMIN,
  platformAdmin: true,
  rawJwt: 'jwt',
};

const FOUND: ForwardGeocodedPlace = {
  formattedAddress: 'Madhepur, Bihar 847408, India',
  latitude: 26.1755791,
  longitude: 86.38009559999999,
  approximate: true,
  city: 'Madhepur',
  state: 'Bihar',
  pincode: '847408',
};
const NOT_FOUND: ForwardGeocodedPlace = {
  formattedAddress: null,
  latitude: null,
  longitude: null,
  approximate: false,
  city: null,
  state: null,
  pincode: null,
};

/** A provider that answers each query from a script and records every query. */
function scripted(
  answer: (query: string, call: number) => ForwardGeocodedPlace | Error,
) {
  const queries: string[] = [];
  const provider = {
    forwardGeocode: jest.fn((query: string) => {
      queries.push(query);
      const result = answer(query, queries.length);
      return result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
    }),
  };
  return { provider, queries };
}

function service(provider: unknown): PlacesService {
  const store = {
    increment: jest
      .fn()
      .mockResolvedValue({ count: 1, windowRemainingSeconds: 60 }),
  };
  const config = { get: () => undefined } as unknown as ConfigService;
  return new PlacesService(
    provider as PlacesProvider,
    store as unknown as PlacesRateLimitStore,
    config,
  );
}

describe('staff forward lookup: name first, then street and state (QA)', () => {
  it('sends the name, street, city, state and PIN in that order on the first query', async () => {
    const { provider, queries } = scripted(() => FOUND);
    await service(provider).geocodeAddress(staff, {
      name: 'Ravi Kumar',
      address: 'MADHEPUR',
      city: 'Madhepur',
      state: 'Bihar',
      pincode: '847408',
    });
    expect(queries).toEqual(['Ravi Kumar, MADHEPUR, Madhepur, Bihar, 847408']);
  });

  it('leaves out a blank name and blank parts, and trims the rest', async () => {
    const { provider, queries } = scripted(() => FOUND);
    await service(provider).geocodeAddress(staff, {
      name: '   ',
      address: '  MADHEPUR  ',
      city: '',
      state: 'Bihar',
      pincode: '  ',
    });
    expect(queries).toEqual(['MADHEPUR, Bihar']);
  });

  it('retries with street and state only when the first query finds nothing', async () => {
    const { provider, queries } = scripted((query) =>
      query.startsWith('Zzqxv') ? NOT_FOUND : FOUND,
    );
    const result = await service(provider).geocodeAddress(staff, {
      name: 'Zzqxv Shop',
      address: 'MADHEPUR',
      state: 'Bihar',
    });
    expect(queries).toEqual(['Zzqxv Shop, MADHEPUR, Bihar', 'MADHEPUR, Bihar']);
    expect(result.latitude).toBe(FOUND.latitude);
  });

  it('does not retry when the first query finds a place', async () => {
    const { provider, queries } = scripted(() => FOUND);
    await service(provider).geocodeAddress(staff, {
      name: 'Ravi Kumar',
      address: 'MADHEPUR',
      state: 'Bihar',
    });
    expect(queries).toHaveLength(1);
  });

  it('makes one lookup when the first query already is the street and state', async () => {
    const { provider, queries } = scripted(() => NOT_FOUND);
    await service(provider).geocodeAddress(staff, {
      address: 'MADHEPUR',
      state: 'Bihar',
    });
    expect(queries).toEqual(['MADHEPUR, Bihar']);
  });

  it('returns the null shape, with both lookups tried, when neither finds a place', async () => {
    const { provider, queries } = scripted(() => NOT_FOUND);
    const result = await service(provider).geocodeAddress(staff, {
      name: 'Zzqxv Shop',
      address: 'zzqxv flimbrot',
      state: 'Bihar',
    });
    expect(queries).toHaveLength(2);
    expect(result).toEqual(NOT_FOUND);
  });

  it('makes no lookup at all when the street is blank, even with a name', async () => {
    const { provider } = scripted(() => FOUND);
    const result = await service(provider).geocodeAddress(staff, {
      name: 'Ravi Kumar',
      address: '   ',
      state: 'Bihar',
    });
    expect(provider.forwardGeocode).not.toHaveBeenCalled();
    expect(result).toEqual(NOT_FOUND);
  });

  it('does not retry when the first lookup fails, and reports the failure', async () => {
    const { provider, queries } = scripted(() => new Error('google down'));
    await expect(
      service(provider).geocodeAddress(staff, {
        name: 'Ravi Kumar',
        address: 'MADHEPUR',
        state: 'Bihar',
      }),
    ).rejects.toThrow();
    expect(queries).toHaveLength(1);
  });

  it('passes the approximate flag and the address parts back to the screen', async () => {
    const { provider } = scripted(() => FOUND);
    const result = await service(provider).geocodeAddress(staff, {
      address: 'MADHEPUR',
      state: 'Bihar',
    });
    expect(result).toEqual(FOUND);
  });
});
