import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, ignoreTrailingSlash: true }),
  );

  // AR-22: Fastify's ignoreTrailingSlash normalizes paths in-place without redirect
  // round-trips and correctly handles POST/PUT bodies (a 301 would drop them).

  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'internal/webhooks/storage'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      errorHttpStatusCode: 422,
    }),
  );

  if (process.env['NODE_ENV'] !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Jobzo API')
      .setDescription('Jobzo field-service management backend API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error(
    'Failed to start application',
    err instanceof Error ? err.stack : String(err),
  );
  process.exit(1);
});
