import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { StorageService } from '../../storage/storage.service';
import { CompanyMember, listCompanyMembers } from './company-members';
import { AVATAR_READ_TTL_SECONDS } from '../../users/avatar.constants';

const logger = new Logger('MemberAvatars');
/** User ids per members read; keeps the PostgREST `in()` filter a sane size. */
const MEMBER_LOOKUP_CHUNK = 200;

/**
 * Turns stored avatar keys into short-lived read links, one link per distinct
 * key (many rows can share one person). Signing is local, so this makes no
 * network call. A key that fails to sign is left out of the map: the caller
 * shows initials instead, and the rest of the response still succeeds.
 */
export async function presignAvatarUrls(
  storage: StorageService,
  keys: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const distinct = [...new Set(keys.filter((k): k is string => Boolean(k)))];
  const entries = await Promise.all(
    distinct.map(async (key) => {
      try {
        const url = await storage.presignReadUrl(key, AVATAR_READ_TTL_SECONDS);
        return [key, url] as const;
      } catch (error) {
        logger.error('Failed to sign avatar read URL', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );
  return new Map(
    entries.filter((e): e is readonly [string, string] => e !== null),
  );
}

/** The link for one person's key, or null when they have no photo (or it failed). */
export function avatarUrlFor(
  urls: Map<string, string>,
  key: string | null | undefined,
): string | null {
  return key ? (urls.get(key) ?? null) : null;
}

/**
 * Photo links for a set of people, keyed by user id. For database functions
 * that return names only: one members read finds their photo keys. A failed
 * members read degrades to no photos (initials), never a failed response.
 */
export async function avatarUrlsByUserId(
  storage: StorageService,
  admin: SupabaseClient,
  tenantId: string,
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const members: CompanyMember[] = [];
  try {
    // Chunked so a long employee list never builds one oversized `in()` filter.
    for (let i = 0; i < userIds.length; i += MEMBER_LOOKUP_CHUNK) {
      members.push(
        ...(await listCompanyMembers(admin, tenantId, {
          userIds: userIds.slice(i, i + MEMBER_LOOKUP_CHUNK),
          includeRemoved: true,
        })),
      );
    }
  } catch (error) {
    logger.error('Failed to read photo keys for people', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
  const urls = await presignAvatarUrls(
    storage,
    members.map((m) => m.avatarKey),
  );
  const byUser = new Map<string, string>();
  for (const member of members) {
    const url = avatarUrlFor(urls, member.avatarKey);
    if (url) byUser.set(member.userId, url);
  }
  return byUser;
}
