import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumber, Max, Min } from 'class-validator';

// Deliberately no `@Type(() => Number)`: class-transformer applies `@Type`
// BEFORE `@Transform`, so `Number('') === 0` would reach the transform as a
// number and `?lat=&lng=` would silently validate as Null Island (0, 0) —
// which is also the mock's reverse-failure sentinel. The transform does the
// whole conversion itself: an empty string becomes `undefined` (rejected by
// @IsNumber with 422), a non-numeric string stays a string (also rejected
// by @IsNumber), and a numeric string becomes a number.
const stringToNumberOrUndefined = ({ value }: { value: unknown }) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(n) ? value : n;
};

export class ReverseQueryDto {
  @ApiProperty({
    example: 19.1364,
    description: 'Pin latitude ([-90, 90]) to reverse geocode',
  })
  @Transform(stringToNumberOrUndefined)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({
    example: 72.8296,
    description: 'Pin longitude ([-180, 180]) to reverse geocode',
  })
  @Transform(stringToNumberOrUndefined)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;
}
