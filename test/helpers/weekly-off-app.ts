import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../../src/app.module';
import { VALIDATION_PIPE_OPTIONS } from '../../src/common/validation-pipe-options';
import { FASTIFY_ROUTER_OPTIONS } from '../../src/common/fastify-adapter-options';
import { allowBodilessDelete } from '../../src/common/allow-bodiless-delete';
import { Crew } from './weekly-off-fixture';
import { accessToken } from './auth-test-utils';

/** The real AppModule with the production pipe, prefix and DELETE parser. */
export async function bootApp(): Promise<{
  app: NestFastifyApplication;
  jwt: JwtService;
}> {
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = mod.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ routerOptions: FASTIFY_ROUTER_OPTIONS }),
  );
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  allowBodilessDelete(app.getHttpAdapter().getInstance());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, jwt: mod.get(JwtService) };
}

/**
 * Authorization header for a user of a crew's tenant. The login token is
 * identity only; company and role come from the user's membership row.
 */
export const bearerFor = (jwt: JwtService, _c: Crew, userId: string) => ({
  authorization: `Bearer ${accessToken(jwt, userId)}`,
});
