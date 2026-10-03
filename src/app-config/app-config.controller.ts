import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '../common/decorators/public.decorator';
import {
  AppConfigPayload,
  AppConfigService,
} from './app-config.service';

@ApiTags('config')
@Controller('config')
export class AppConfigController {
  constructor(private readonly appConfigService: AppConfigService) {}

  /**
   * Public (pre-login) app configuration — clients boot on shipped defaults
   * and overlay this payload. The CF worker edge-caches this exact route
   * (60s TTL, bare-URL cache key): keep the response identical for every
   * caller — no per-user data, no query parameters — or the cache key stops
   * being sound (spec constraint).
   */
  @Get('app')
  @Public()
  @ApiOperation({
    summary: 'Server-driven configuration for the mobile app (public)',
  })
  @ApiOkResponse({
    description: 'Flat config map + configVersion',
    schema: {
      type: 'object',
      properties: {
        config: { type: 'object', additionalProperties: true },
        configVersion: { type: 'string', example: '2026-10-03T20:00:00.000Z' },
      },
    },
  })
  async getApp(@Res({ passthrough: true }) reply: FastifyReply): Promise<AppConfigPayload> {
    const { payload, etag } = await this.appConfigService.getAppConfig();
    // Direct hits (bypassing the worker) still get sane shared-cache
    // headers; on the worker path it overrides Cache-Control with its own
    // edge TTL. The ETag is honored edge-side: the worker's cache.match
    // evaluates If-None-Match against it.
    reply.header('etag', etag);
    reply.header('cache-control', 'public, max-age=60');
    return payload;
  }
}
