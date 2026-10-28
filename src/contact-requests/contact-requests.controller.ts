import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { ContactRequestResponseDto } from './dto/contact-request-response.dto';
import { CreateContactRequestDto } from './dto/create-contact-request.dto';
import { ContactRequestsService } from './contact-requests.service';

@ApiTags('Contact requests')
@Controller('contact-requests')
export class ContactRequestsController {
  constructor(
    private readonly contactRequestsService: ContactRequestsService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ask for a call back or a demo (public)',
  })
  @ApiResponse({
    status: 202,
    description: 'Saved. The message says what happens next.',
    type: ContactRequestResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'No email and no phone given',
  })
  @ApiResponse({ status: 422, description: 'Invalid email, phone or text' })
  @ApiResponse({ status: 500, description: 'Could not save the request' })
  async submit(
    @Body() dto: CreateContactRequestDto,
  ): Promise<ContactRequestResponseDto> {
    const message = await this.contactRequestsService.submit(dto);
    return { message };
  }
}
