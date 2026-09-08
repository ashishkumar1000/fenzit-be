import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';

/**
 * Format contract for a placeId before it reaches the (billable) provider:
 * URL-safe base64-ish charset, 10–255 chars. Matches every shape we issue —
 * real Google Place IDs (e.g. `ChIJbU60yXAWrjsR4E9-UejD3_g`), the mock
 * fixtures (`mock-place-andheri-west-1`), and the non-production sentinel
 * `__simulate_resolve_error__` — while rejecting proto-pollution vectors,
 * control characters, and absurd lengths before a network call is made.
 * A well-formed but unknown placeId still maps to the documented 502 path.
 */
export const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{10,255}$/;

export class PlaceIdParamsDto {
  @ApiProperty({
    name: 'placeId',
    example: 'mock-place-andheri-west-1',
    description: 'Place ID from a prior autosuggest result',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(PLACE_ID_PATTERN, {
    message: 'placeId must be 10-255 url-safe characters (A-Z, a-z, 0-9, _, -)',
  })
  placeId: string;
}
