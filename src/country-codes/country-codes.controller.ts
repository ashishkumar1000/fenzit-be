import { Controller, Get, Header, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CountryCodeResponseDto } from './dto/country-code-response.dto';
import { CountryCodesService } from './country-codes.service';

@ApiTags('Country codes')
@Controller('country-codes')
export class CountryCodesController {
  constructor(private readonly countryCodesService: CountryCodesService) {}

  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'List phone country codes (public reference data)' })
  @ApiResponse({ status: 200, type: [CountryCodeResponseDto] })
  @ApiResponse({ status: 500, description: 'Could not load the list' })
  list(): Promise<CountryCodeResponseDto[]> {
    return this.countryCodesService.list();
  }
}
