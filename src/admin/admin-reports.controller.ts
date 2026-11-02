import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can } from '../common/decorators/can.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { AdminReportsService } from './admin-reports.service';
import {
  ListAttachmentReportsQueryDto,
  ResolveAttachmentReportDto,
} from './dto/attachment-reports.dto';

/** Photo report queue for Fenzit platform admins only (user.manage). */
@ApiTags('Admin')
@ApiBearerAuth()
@Controller()
export class AdminReportsController {
  constructor(private readonly adminReportsService: AdminReportsService) {}

  @Get('admin/attachment-reports')
  @Can('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List reported job photos (platform admin only; open by default)',
  })
  @ApiResponse({ status: 403, description: 'Not a platform admin' })
  list(@Query() query: ListAttachmentReportsQueryDto) {
    return this.adminReportsService.list(query.status);
  }

  @Post('admin/attachment-reports/:reportId/resolve')
  @Can('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Hide the reported photo or dismiss the report (platform admin only)',
  })
  @ApiResponse({ status: 404, description: 'Report not found' })
  @ApiResponse({ status: 409, description: 'Report already resolved' })
  resolve(
    @CurrentUser() user: RequestUser,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: ResolveAttachmentReportDto,
  ) {
    return this.adminReportsService.resolve(user, reportId, dto.action);
  }
}
