import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { JwtModule } from '@nestjs/jwt';
import * as Joi from 'joi';
import { HealthController } from './health/health.controller';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { AuthModule } from './auth/auth.module';
import { SkillsModule } from './skills/skills.module';
import { CustomersModule } from './customers/customers.module';
import { JobsModule } from './jobs/jobs.module';
import { StorageModule } from './storage/storage.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { SupabaseModule } from './supabase/supabase.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'production', 'test')
          .default('development'),
        PORT: Joi.number().default(3000),
        SUPABASE_URL: Joi.string().uri().required(),
        SUPABASE_ANON_KEY: Joi.string().required(),
        SUPABASE_JWT_SECRET: Joi.string().required(),
        SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),
        CLOUDFLARE_R2_ACCOUNT_ID: Joi.string().required(),
        CLOUDFLARE_R2_ACCESS_KEY: Joi.string().required(),
        CLOUDFLARE_R2_SECRET_KEY: Joi.string().required(),
        CLOUDFLARE_R2_BUCKET: Joi.string().required(),
        WORKER_WEBHOOK_SECRET: Joi.string().required(),
        // Optional max client-reported attachment size in bytes (default 50 MB
        // in AttachmentsService). Must stay <= INT max (2,147,483,647).
        MAX_ATTACHMENT_SIZE_BYTES: Joi.number()
          .integer()
          .positive()
          .max(2147483647)
          .optional(),
      }),
      validationOptions: {
        abortEarly: false,
      },
    }),
    CacheModule.register({
      isGlobal: true,
      ttl: 300,
    }),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env['SUPABASE_JWT_SECRET'],
        signOptions: { expiresIn: '7d' },
      }),
      global: true,
    }),
    SupabaseModule,
    AuthModule,
    SkillsModule,
    CustomersModule,
    JobsModule,
    StorageModule,
    WebhooksModule,
    SyncModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
export class AppModule {}
