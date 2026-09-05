import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PlacesService } from './places.service';
import { AutosuggestQueryDto } from './dto/autosuggest-query.dto';
import { AutosuggestResponseDto } from './dto/autosuggest-response.dto';
import { ResolveQueryDto } from './dto/resolve-query.dto';
import { ResolvedPlaceDto } from './dto/resolve-response.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

@ApiTags('Places')
@ApiBearerAuth()
@Controller('places')
export class PlacesController {
  constructor(private readonly placesService: PlacesService) {}

  @Get('autosuggest')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Address autosuggest for customer address entry' })
  @ApiResponse({
    status: 200,
    description: 'Suggestions list (possibly empty)',
    type: AutosuggestResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  @ApiResponse({ status: 502, description: 'Places provider upstream error' })
  autosuggest(
    @CurrentUser() user: RequestUser,
    @Query() query: AutosuggestQueryDto,
  ) {
    return this.placesService.autosuggest(user, query.q, query.sessionToken);
  }

  @Get('resolve/:placeId')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve a place-autosuggest selection to a full address',
  })
  @ApiParam({
    name: 'placeId',
    example: 'mock-place-andheri-west-1',
    description: 'Place ID from a prior autosuggest result',
  })
  @ApiResponse({
    status: 200,
    description: 'Resolved place detail',
    type: ResolvedPlaceDto,
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  @ApiResponse({ status: 502, description: 'Places provider upstream error' })
  resolve(
    @CurrentUser() user: RequestUser,
    @Param('placeId') placeId: string,
    @Query() query: ResolveQueryDto,
  ) {
    return this.placesService.resolve(user, placeId, query.sessionToken);
  }
}
