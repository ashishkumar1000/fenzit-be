import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from './common/validation-pipe-options';
import { CorrelationLogger } from './common/correlation/correlation-logger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { FASTIFY_ROUTER_OPTIONS } from './common/fastify-adapter-options';
import { allowBodilessDelete } from './common/allow-bodiless-delete';
import { addRequestMetricsHooks, initTelemetry } from './telemetry';
import fastifyCors from '@fastify/cors';
import { buildCorsOptions } from './common/cors/cors-options';
import { parseCorsOrigins } from './common/cors/cors-origins';

async function bootstrap(): Promise<void> {
  // Start metrics export before any instrumented code runs (no-op without
  // OTEL_EXPORTER_OTLP_ENDPOINT — see src/telemetry/telemetry.ts).
  await initTelemetry();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false,
      routerOptions: FASTIFY_ROUTER_OPTIONS,
      // Close idle keep-alive connections on server close so the SIGTERM
      // drain (Render deploys) can finish inside the 30s grace window.
      forceCloseConnections: 'idle',
    }),
  );

  // AR-22: Fastify's ignoreTrailingSlash normalizes paths in-place without redirect
  // round-trips and correctly handles POST/PUT bodies (a 301 would drop them).

  app.setGlobalPrefix('api/v1', {
    // Health rides the prefix (/api/v1/health) so the prod proxy worker —
    // which forwards ONLY /api/v1/* — can reach it. 2026-09-21: it used to
    // be excluded here, which made /health unreachable at api.fenzit.com
    // (the worker 404'd the bare path, and /api/v1/health 404'd at the
    // the backend). If Render's health-check path is configured (dashboard
    // → Settings → Health Check Path), it must match /api/v1/health now —
    // an unprefixed /health probe would 404 and fail deploys.
    exclude: ['internal/webhooks/storage'],
  });

  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

  // Browser access for the web app (fenzit-web). Exact origins only, from
  // CORS_ALLOWED_ORIGINS; a bad value throws here and stops the boot.
  // @fastify/cors is typed against the top-level fastify, but Nest bundles its
  // own copy (5.11 vs 5.12). The plugin API is identical at runtime, so the
  // cast stays at this one boundary, as in allow-bodiless-delete.ts.
  await app.register(
    fastifyCors as Parameters<typeof app.register>[0],
    buildCorsOptions(parseCorsOrigins(process.env['CORS_ALLOWED_ORIGINS'])),
  );

  // R-15: a body-less DELETE with a JSON content-type must reach the guards.
  allowBodilessDelete(app.getHttpAdapter().getInstance());

  // Route every Logger.log/... call (framework + `new Logger(...)` instances)
  // through the correlation-aware logger — see story 13.1.
  app.useLogger(new CorrelationLogger());

  // Grafana Cloud request metrics (counter + duration histogram) per route
  // template. Attached directly to the Fastify instance rather than via
  // app.register — see fastify-metrics.plugin.ts for why. No-op when
  // telemetry is off.
  addRequestMetricsHooks(app.getHttpAdapter().getInstance());

  // Graceful shutdown: Render sends SIGTERM on deploys/scale-downs.
  // Without this, SIGTERM kills the process immediately and drops
  // in-flight requests. The final telemetry flush runs via the
  // TelemetryShutdown lifecycle provider (app.module.ts), which Nest
  // invokes after the server has closed.
  app.enableShutdownHooks();

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
