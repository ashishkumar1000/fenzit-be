import type { SupabaseClient } from '@supabase/supabase-js';
import { StorageService } from '../../storage/storage.service';
import { CompanyMember, listCompanyMembers } from './company-members';
import {
  avatarUrlFor,
  avatarUrlsByUserId,
  presignAvatarUrls,
} from './member-avatars';

jest.mock('./company-members', () => ({
  listCompanyMembers: jest.fn(),
}));

const mockList = listCompanyMembers as jest.MockedFunction<
  typeof listCompanyMembers
>;

const TENANT = '11111111-1111-4111-8111-111111111111';

function storageSigning(
  sign: (key: string) => Promise<string> = (key) =>
    Promise.resolve(`https://signed.example/${key}`),
) {
  const presignReadUrl = jest.fn((key: string) => sign(key));
  return {
    storage: { presignReadUrl } as unknown as StorageService,
    presignReadUrl,
  };
}

function member(userId: string, avatarKey: string | null): CompanyMember {
  return {
    userId,
    name: `person ${userId}`,
    countryCode: '+91',
    phoneNumber: '9000000000',
    employeeCode: null,
    role: 'employee',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    avatarKey,
  } as unknown as CompanyMember;
}

describe('presignAvatarUrls', () => {
  it('signs each distinct key once and ignores null and empty keys', async () => {
    const { storage, presignReadUrl } = storageSigning();

    const urls = await presignAvatarUrls(storage, [
      'avatars/a.jpg',
      'avatars/a.jpg',
      null,
      undefined,
      '',
      'avatars/b.jpg',
    ]);

    expect(presignReadUrl).toHaveBeenCalledTimes(2);
    expect(urls.get('avatars/a.jpg')).toBe('https://signed.example/avatars/a.jpg');
    expect(urls.get('avatars/b.jpg')).toBe('https://signed.example/avatars/b.jpg');
    expect(urls.size).toBe(2);
  });

  it('leaves out a key whose signing fails and keeps the rest', async () => {
    const { storage } = storageSigning((key) =>
      key === 'avatars/bad.jpg'
        ? Promise.reject(new Error('sign failed'))
        : Promise.resolve(`https://signed.example/${key}`),
    );

    const urls = await presignAvatarUrls(storage, [
      'avatars/bad.jpg',
      'avatars/good.jpg',
    ]);

    expect(urls.has('avatars/bad.jpg')).toBe(false);
    expect(urls.get('avatars/good.jpg')).toBe('https://signed.example/avatars/good.jpg');
  });
});

describe('avatarUrlFor', () => {
  it('returns null for a missing key, a null key, or an unknown key', () => {
    const urls = new Map([['avatars/a.jpg', 'https://signed.example/a']]);
    expect(avatarUrlFor(urls, null)).toBeNull();
    expect(avatarUrlFor(urls, undefined)).toBeNull();
    expect(avatarUrlFor(urls, 'avatars/other.jpg')).toBeNull();
    expect(avatarUrlFor(urls, 'avatars/a.jpg')).toBe('https://signed.example/a');
  });
});

describe('avatarUrlsByUserId', () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it('returns an empty map without reading when there are no people', async () => {
    const { storage } = storageSigning();
    const result = await avatarUrlsByUserId(storage, {} as SupabaseClient, TENANT, []);
    expect(result.size).toBe(0);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('maps each person to their own link and leaves photo-less people out', async () => {
    mockList.mockResolvedValue([
      member('u1', 'avatars/u1.jpg'),
      member('u2', null),
    ]);
    const { storage } = storageSigning();

    const byUser = await avatarUrlsByUserId(storage, {} as SupabaseClient, TENANT, [
      'u1',
      'u2',
    ]);

    expect(byUser.get('u1')).toBe('https://signed.example/avatars/u1.jpg');
    expect(byUser.has('u2')).toBe(false);
  });

  it('degrades to no photos, never throws, when the members read fails', async () => {
    mockList.mockRejectedValue(new Error('db down'));
    const { storage, presignReadUrl } = storageSigning();

    const byUser = await avatarUrlsByUserId(storage, {} as SupabaseClient, TENANT, [
      'u1',
    ]);

    expect(byUser.size).toBe(0);
    expect(presignReadUrl).not.toHaveBeenCalled();
  });

  it('reads in chunks of 200 ids and scopes every read to the tenant', async () => {
    mockList.mockImplementation(async (_admin, _tenant, filter) =>
      (filter?.userIds ?? []).map((id) => member(id, `avatars/${id}.jpg`)),
    );
    const { storage } = storageSigning();
    const ids = Array.from({ length: 450 }, (_, i) => `u${i}`);

    const byUser = await avatarUrlsByUserId(storage, {} as SupabaseClient, TENANT, ids);

    expect(mockList).toHaveBeenCalledTimes(3);
    for (const call of mockList.mock.calls) {
      expect(call[1]).toBe(TENANT);
      expect(call[2]?.userIds?.length).toBeLessThanOrEqual(200);
    }
    expect(byUser.size).toBe(450);
    expect(byUser.get('u449')).toBe('https://signed.example/avatars/u449.jpg');
  });
});
