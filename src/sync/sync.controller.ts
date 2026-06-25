import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SyncService } from './sync.service';
import { SyncRequestDto } from './dto/sync-request.dto';
import { SyncResponseDto } from './dto/sync-response.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

@ApiTags('Sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post()
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delta sync — returns jobs changed since last_synced_at' })
  @ApiResponse({ status: 200, description: 'Sync payload', type: SyncResponseDto })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Owner JWT not allowed' })
  @ApiResponse({ status: 422, description: 'Invalid last_synced_at format' })
  sync(
    @CurrentUser() user: RequestUser,
    @Body() dto: SyncRequestDto,
  ): Promise<SyncResponseDto> {
    return this.syncService.sync(user, dto.lastSyncedAt);
  }
}
