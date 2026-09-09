import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { NotificationResponse } from './dto/notification-response.dto';
import {
  MarkReadResponse,
  UnreadCountResponse,
} from './dto/notification-count-response.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';

// Deliberately no @Roles(...) and no @UseGuards(...): guards are global
// APP_GUARDs, and authorization here is recipient-scoping (user_id = sub) —
// stronger than a role gate and safe for a solo owner-technician tenant.
@ApiTags('Notifications')
@ApiBearerAuth()
@ApiExtraModels(PaginatedResponse, NotificationResponse)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "List the caller's notifications, newest first (keyset-paginated, default page 20)",
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated notification list',
    schema: {
      allOf: [
        { $ref: getSchemaPath(PaginatedResponse) },
        {
          properties: {
            data: {
              type: 'array',
              items: { $ref: getSchemaPath(NotificationResponse) },
            },
          },
        },
      ],
    },
  })
  @ApiResponse({ status: 400, description: 'Malformed or foreign cursor' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  listNotifications(
    @CurrentUser() user: RequestUser,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notificationsService.listNotifications(user, query);
  }

  @Get('unread-count')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Count the caller's unread notifications" })
  @ApiResponse({ status: 200, type: UnreadCountResponse })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  getUnreadCount(@CurrentUser() user: RequestUser) {
    return this.notificationsService.getUnreadCount(user);
  }

  @Post('mark-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark specific notifications read (own unread rows only; foreign/missing ids silently no-op)',
  })
  @ApiResponse({ status: 200, type: MarkReadResponse })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  markRead(@CurrentUser() user: RequestUser, @Body() dto: MarkReadDto) {
    return this.notificationsService.markRead(user, dto);
  }

  @Post('mark-all-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all unread notifications read' })
  @ApiResponse({ status: 200, type: MarkReadResponse })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  markAllRead(@CurrentUser() user: RequestUser) {
    return this.notificationsService.markAllRead(user);
  }
}
