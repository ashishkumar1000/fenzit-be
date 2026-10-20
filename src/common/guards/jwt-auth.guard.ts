import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ErrorCode } from '../enums/error-code.enum';
import { Role } from '../enums/role.enum';
import { RequestUser } from '../interfaces/request-user.interface';
import { MembershipResolver } from '../auth/membership-resolver';

/** The marker every login token carries (decision 23). */
export const ACCESS_TOKEN_TYPE = 'access';

/** Header a platform admin uses to name the company a request acts on. */
export const COMPANY_HEADER = 'x-company-id';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface JwtPayload {
  sub: string;
  typ?: string;
  iat: number;
  exp?: number;
}

/**
 * Authenticates a request and builds `request.user` from the database.
 *
 * Any token signed with SUPABASE_JWT_SECRET verifies here — including
 * short-lived Realtime tokens (role: 'authenticated') and Supabase's own
 * service_role key. Those must never open the REST API, so the token must
 * carry the `typ: 'access'` marker that only a login mints (decision 23).
 *
 * Company and role are read per request, never from the token: a removed or
 * disabled person is refused on their next request (decisions 6 and 35).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly membershipResolver: MembershipResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException({
        error_code: ErrorCode.UNAUTHORIZED,
        message: 'Missing or malformed Authorization header',
      });
    }

    let payload: JwtPayload;
    try {
      const secret = this.configService.getOrThrow<string>(
        'SUPABASE_JWT_SECRET',
      );
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException({
        error_code: ErrorCode.UNAUTHORIZED,
        message: 'Invalid or expired token',
      });
    }

    // Kept outside the catch above so its message is not swallowed by the
    // generic "Invalid or expired token" rewrite.
    if (
      payload.typ !== ACCESS_TOKEN_TYPE ||
      typeof payload.sub !== 'string' ||
      !UUID_RE.test(payload.sub)
    ) {
      throw new UnauthorizedException({
        error_code: ErrorCode.UNAUTHORIZED,
        message: 'Token is not valid for API access',
      });
    }

    let access;
    try {
      access = await this.membershipResolver.resolve(payload.sub);
    } catch {
      throw new InternalServerErrorException({ error_code: ErrorCode.INTERNAL_SERVER_ERROR, message: 'Could not check your access' });
    }

    // Unknown or disabled: the same generic 401 as a bad token, so the
    // response never says which.
    if (!access || access.disabled) {
      throw new UnauthorizedException({
        error_code: ErrorCode.UNAUTHORIZED,
        message: 'Invalid or expired token',
      });
    }

    let tenantId: string | null = access.membership?.tenantId ?? null;
    let role: Role | null = access.membership?.role ?? null;

    if (access.platformAdmin) {
      // Fenzit staff act on the company named in X-Company-Id, and only they
      // may (a company member's header is ignored).
      role = Role.PLATFORM_ADMIN;
      tenantId = await this.companyFromHeader(request);
    }

    const user: RequestUser = {
      userId: access.userId,
      tenantId,
      role,
      platformAdmin: access.platformAdmin,
      rawJwt: token,
    };

    (request as FastifyRequest & { user: RequestUser }).user = user;

    return true;
  }

  private async companyFromHeader(
    request: FastifyRequest,
  ): Promise<string | null> {
    const raw = request.headers[COMPANY_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) {
      return null;
    }
    if (!UUID_RE.test(value) || !(await this.membershipResolver.companyExists(value))) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Company not found',
      });
    }
    return value.toLowerCase();
  }

  private extractTokenFromHeader(request: FastifyRequest): string | null {
    const authHeader = request.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') {
      return null;
    }
    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' && token ? token : null;
  }
}
