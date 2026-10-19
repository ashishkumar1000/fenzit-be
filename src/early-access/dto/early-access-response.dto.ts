import { ApiProperty } from '@nestjs/swagger';

export class EarlyAccessResponseDto {
  @ApiProperty({
    example: 'Thanks. We will email you when access opens.',
    description:
      'The same message whether the email is new or already on the list, so the response cannot be used to check who has signed up.',
  })
  message: string;
}
