import {
  CanActivate,
  ExecutionContext,
  Injectable,
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

interface JwtPayload {
  sub: string;
  tenantId: string | null;
  role: Role;
  iat: number;
  exp: number;
}

/**
 * Any token signed with SUPABASE_JWT_SECRET verifies here — including
 * short-lived Realtime tokens (role: 'authenticated') and Supabase's own
 * service_role key. Those must never open the REST API, so the role claim is
 * checked against the app's own roles after verification. Realtime tokens are
 * for the Realtime socket only (where Supabase itself requires
 * role: 'authenticated') — see AuthService.mintRealtimeToken.
 */
const APP_ROLES = new Set<string>([Role.OWNER, Role.TECHNICIAN]);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
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
    if (typeof payload.role !== 'string' || !APP_ROLES.has(payload.role)) {
      throw new UnauthorizedException({
        error_code: ErrorCode.UNAUTHORIZED,
        message: 'Token is not valid for API access',
      });
    }

    const user: RequestUser = {
      userId: payload.sub,
      tenantId: payload.tenantId ?? null,
      role: payload.role,
      rawJwt: token,
    };

    (request as FastifyRequest & { user: RequestUser }).user = user;

    return true;
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
