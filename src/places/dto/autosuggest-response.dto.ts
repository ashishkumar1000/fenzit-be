import { ApiProperty } from '@nestjs/swagger';

export class PlaceSuggestionDto {
  @ApiProperty({ example: 'mock-place-andheri-west-1' })
  placeId: string;

  @ApiProperty({ example: 'Andheri West, Mumbai, Maharashtra, India' })
  text: string;
}

export class AutosuggestResponseDto {
  @ApiProperty({ type: [PlaceSuggestionDto] })
  suggestions: PlaceSuggestionDto[];
}
