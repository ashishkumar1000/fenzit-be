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
import { PlaceIdParamsDto } from './dto/place-id-params.dto';
import { ResolveQueryDto } from './dto/resolve-query.dto';
import { ResolvedPlaceDto } from './dto/resolve-response.dto';
import { ReverseQueryDto } from './dto/reverse-query.dto';
import { GeocodeQueryDto } from './dto/geocode-query.dto';
import { GeocodeResponseDto } from './dto/geocode-response.dto';
import { ReverseGeocodedAddressDto } from './dto/reverse-response.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { Can } from '../common/decorators/can.decorator';

@ApiTags('Places')
@ApiBearerAuth()
@Controller('places')
export class PlacesController {
  constructor(private readonly placesService: PlacesService) {}

  @Get('autosuggest')
  @Can('places.search')
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
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded — response carries a Retry-After header (seconds to wait before retrying)',
  })
  @ApiResponse({ status: 502, description: 'Places provider upstream error' })
  autosuggest(
    @CurrentUser() user: RequestUser,
    @Query() query: AutosuggestQueryDto,
  ) {
    return this.placesService.autosuggest(user, query.q, query.sessionToken);
  }

  @Get('resolve/:placeId')
  @Can('places.search')
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
  @ApiResponse({
    status: 422,
    description:
      'Validation error — includes a placeId violating the format contract (10–255 url-safe characters)',
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded — response carries a Retry-After header (seconds to wait before retrying)',
  })
  @ApiResponse({ status: 502, description: 'Places provider upstream error' })
  resolve(
    @CurrentUser() user: RequestUser,
    // Validated by the global ValidationPipe (format/length) before any
    // provider call — see PlaceIdParamsDto for the format contract.
    @Param() params: PlaceIdParamsDto,
    @Query() query: ResolveQueryDto,
  ) {
    return this.placesService.resolve(user, params.placeId, query.sessionToken);
  }

  @Get('reverse')
  @Can('places.search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reverse geocode raw coordinates into an address (map-picker pin row)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Resolved address — all fields null when the point has no address (e.g. open water)',
    type: ReverseGeocodedAddressDto,
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 422,
    description:
      'Validation error — lat/lng outside ([-90, 90]) / ([-180, 180]) or non-numeric',
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded — response carries a Retry-After header (seconds to wait before retrying)',
  })
  @ApiResponse({ status: 502, description: 'Places provider upstream error' })
  reverse(@CurrentUser() user: RequestUser, @Query() query: ReverseQueryDto) {
    return this.placesService.reverse(user, query.lat, query.lng);
  }

  // Staff-only (user.manage): the bulk-import screen geocodes typed addresses
  // on the staff member's own account, not on a company's. Owners get 403.
  @Get('geocode')
  @Can('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Forward geocode a typed address into coordinates (staff bulk import)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Coordinates, or all fields null when the address matches nothing',
    type: GeocodeResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — staff only' })
  @ApiResponse({
    status: 422,
    description: 'Validation error — address empty or too long',
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded — Retry-After header set',
  })
  @ApiResponse({ status: 502, description: 'Places provider upstream error' })
  geocode(@CurrentUser() user: RequestUser, @Query() query: GeocodeQueryDto) {
    return this.placesService.geocodeAddress(user, {
      address: query.address,
      city: query.city,
      state: query.state,
      pincode: query.pincode,
    });
  }
}
