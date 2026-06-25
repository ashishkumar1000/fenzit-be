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

    try {
      const secret = this.configService.getOrThrow<string>(
        'SUPABASE_JWT_SECRET',
      );
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret,
        algorithms: ['HS256'],
      });

      const user: RequestUser = {
        userId: payload.sub,
        tenantId: payload.tenantId ?? null,
        role: payload.role,
        rawJwt: token,
      };

      (request as FastifyRequest & { user: RequestUser }).user = user;
    } catch {
      throw new UnauthorizedException({
        error_code: ErrorCode.UNAUTHORIZED,
        message: 'Invalid or expired token',
      });
    }

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
