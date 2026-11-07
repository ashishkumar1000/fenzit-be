import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';

/**
 * TTL for the minted PostgREST access token. Short-lived by design — one
 * catalog read per request.
 */
export const POSTGREST_TOKEN_TTL_SECONDS = 900;

@Injectable()
export class SkillsService {
  private readonly logger = new Logger(SkillsService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Global skills catalog — seeded by migrations, read-only for the API.
   * PostgREST switches to the DB role named in the JWT's `role` claim, and the
   * app's owner/technician roles are not DB roles — so the read is made with a
   * short-lived role:'authenticated' token carrying the caller's sub (same
   * claim shape as AuthService.mintRealtimeToken; jsonwebtoken throws when a
   * payload `exp` meets an `expiresIn` option, so only the payload `exp` is
   * set). This keeps the `skills_authenticated_read` RLS policy actually
   * exercised — never createAdmin() here.
   */
  async listGlobalSkills(user: RequestUser): Promise<
    {
      id: string;
      name: string;
      description: string;
      icon: string;
      is_fallback: boolean;
    }[]
  > {
    const exp = Math.floor(Date.now() / 1000) + POSTGREST_TOKEN_TTL_SECONDS;
    const token = await this.jwtService.signAsync({
      sub: user.userId,
      role: 'authenticated',
      exp,
    });
    const client = this.supabaseClientFactory.create(token);

    const { data, error } = await client
      .from('skills')
      .select('id, name, description, icon, is_fallback')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) {
      this.logger.error('Failed to list skills:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list skills',
      });
    }

    return (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      is_fallback: row.is_fallback,
    }));
  }

  /**
   * Records an owner's request for a skill the catalog does not have. This
   * only files a note for the Fenzit team; it never adds a skill. The company
   * comes from the caller's token-checked membership, never from the body.
   * A repeat of the same name (ignoring case) for the same company is not an
   * error: the answer says it was already requested.
   */
  async createSkillRequest(
    user: RequestUser,
    name: string,
  ): Promise<{ already_requested: boolean }> {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before requesting a skill',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();
    const { error } = await admin.from('skill_requests').insert({
      tenant_id: user.tenantId,
      requested_by: user.userId,
      name,
    });

    if (!error) return { already_requested: false };
    // 23505: the same company already asked for this name.
    if (error.code === '23505') return { already_requested: true };
    if (error.code === '23514') {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Skill name must be 2 to 60 characters',
      });
    }

    this.logger.error('Failed to save skill request:', { error });
    throw new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'Failed to save skill request',
    });
  }
}
