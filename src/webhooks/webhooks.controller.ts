import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { WebhooksService } from './webhooks.service';
import { StorageEventDto } from './dto/storage-event.dto';

@Controller('internal/webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('storage')
  @Public()
  @HttpCode(HttpStatus.OK)
  async handleStorageEvent(
    @Headers('authorization') auth: string | undefined,
    @Body() body: StorageEventDto,
  ): Promise<void> {
    return this.webhooksService.handleStorageEvent(auth, body);
  }
}
