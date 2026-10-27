import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  buildDossier,
  findUserByPhone,
  type Dossier,
  type DossierUser,
} from './admin-dossier';

/** The lookup response: who the person is, their auth facts, and the dossier. */
export interface LookupResult extends Dossier {
  user: DossierUser & {
    lastSignInAt: string | null;
    authCreatedAt: string | null;
  };
}

/** Splits an E.164-ish number against the known dial codes: the longest
 *  matching prefix wins, so '+91 98765 43210' and '+1 212 555 0100' both
 *  resolve. Pure — the dial codes come from the country_codes table. */
export function splitDialCode(
  digits: string,
  dialCodes: string[],
): { countryCode: string; phoneNumber: string } | null {
  const candidates = dialCodes
    .filter((d) => digits.startsWith(d))
    .sort((a, b) => b.length - a.length);
  for (const code of candidates) {
    const rest = digits.slice(code.length);
    if (/^\d{4,14}$/.test(rest)) return { countryCode: code, phoneNumber: rest };
  }
  return null;
}

/** Accepts the generic full form (`+<dial code> <number>`, spaces and dashes
 *  ignored) and, for convenience, a bare 10-digit number which defaults to
 *  +91 — the market the product launches in. Null when nothing matches. */
export function parsePhone(
  input: string,
  dialCodes: string[],
): { countryCode: string; phoneNumber: string } | null {
  const digits = input.replace(/[\s()+.-]/g, '');
  if (digits.startsWith('+')) return splitDialCode(digits.slice(1), dialCodes);
  if (/^\d{10}$/.test(digits)) return { countryCode: '+91', phoneNumber: digits };
  if (/^91\d{10}$/.test(digits)) return { countryCode: '+91', phoneNumber: digits.slice(2) };
  return null;
}

/**
 * Staff-only admin reads and flag writes (web admin spec, 2026-10-26).
 * No database changes anywhere: the dossier is read-only SELECTs over the
 * existing tables; the flag write is a plain guarded UPDATE (the
 * project-context rule-6 pattern), never a new RPC. Audit for the flag
 * write comes from the platform-audit interceptor, which logs this
 * controller's `:userId` POST route automatically.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly pg: PgPoolFactory,
    private readonly supabaseFactory: SupabaseClientFactory,
  ) {}

  async lookup(phoneInput: string): Promise<LookupResult> {
    const phone = parsePhone(phoneInput, await this.dialCodes());
    if (!phone) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Enter the full phone number, including the country code (for example +91 98765 43210)',
      });
    }
    const found = await this.pg.withTransaction((tx) => findUserByPhone(tx, phone));
    if (!found) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: `No person with the number +${phone.countryCode.replace('+', '')} ${phone.phoneNumber}`,
      });
    }
    const [dossier, authFacts] = await Promise.all([
      this.pg.withTransaction(async (tx) => {
        const live = await this.primaryLiveMembership(tx, found.id);
        return buildDossier(tx, found, live);
      }),
      this.authFacts(found.id),
    ]);
    return { user: { ...found, ...authFacts }, ...dossier };
  }

  async setPlatformAdmin(
    caller: RequestUser,
    userId: string,
    value: boolean,
  ): Promise<{ userId: string; platformAdmin: boolean }> {
    // Postgres uuid input is case-insensitive, so the string compare must be
    // too — an uppercased self-id would otherwise slip past the guard.
    if (userId.toLowerCase() === caller.userId.toLowerCase()) {
      throw new ConflictException({
        error_code: ErrorCode.PLATFORM_ADMIN_SELF,
        message: 'You cannot change your own platform-admin flag here — ask another platform admin',
      });
    }
    // Guarded UPDATE: the `neq` predicate makes the write a no-op when the
    // flag already holds, so zero rows means either an unknown id or an
    // unchanged flag — re-read to tell the two apart (404 vs idempotent 200).
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('users')
      .update({ platform_admin: value })
      .eq('id', userId)
      .neq('platform_admin', value)
      .select('id');
    if (error) {
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to update the account',
      });
    }
    if (data && data.length > 0) return { userId, platformAdmin: value };
    const { data: existing } = await this.supabaseFactory
      .createAdmin()
      .from('users')
      .select('platform_admin')
      .eq('id', userId)
      .maybeSingle();
    if (!existing) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'No such user',
      });
    }
    return { userId, platformAdmin: Boolean(existing.platform_admin) };
  }

  /** The known dial codes, for splitting a generic +<code><number> input.
   *  A read-only lookup of the existing country_codes table; if it cannot be
   *  read the parser still works for +91 and bare 10-digit inputs. */
  private async dialCodes(): Promise<string[]> {
    try {
      const { data, error } = await this.supabaseFactory
        .createAdmin()
        .from('country_codes')
        .select('dial_code');
      if (error || !data) return ['+91'];
      return data.map((r: { dial_code: string }) => r.dial_code);
    } catch {
      return ['+91'];
    }
  }

  /** The person's first live membership — whose company the dossier's
   *  company summary describes (the CLI's primary-membership rule). */
  private async primaryLiveMembership(
    tx: import('pg').PoolClient,
    userId: string,
  ): Promise<{ tenantId: string; companyName: string } | null> {
    const { rows } = await tx.query(
      `select m.tenant_id, t.company_name
         from public.memberships m
         join public.tenants t on t.id = m.tenant_id
        where m.user_id = $1 and m.status <> 'removed'
        order by m.created_at
        limit 1`,
      [userId],
    );
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? { tenantId: String(r.tenant_id), companyName: String(r.company_name) } : null;
  }

  /** Login-identity facts from auth. Nulls when the auth schema is not
   *  readable from this deployment — never a fabricated value. */
  private async authFacts(
    userId: string,
  ): Promise<{ lastSignInAt: string | null; authCreatedAt: string | null }> {
    try {
      const { data, error } = await this.supabaseFactory
        .createAdmin()
        .auth.admin.getUserById(userId);
      if (error || !data?.user) return { lastSignInAt: null, authCreatedAt: null };
      return {
        lastSignInAt: data.user.last_sign_in_at ?? null,
        authCreatedAt: data.user.created_at ?? null,
      };
    } catch {
      return { lastSignInAt: null, authCreatedAt: null };
    }
  }
}
