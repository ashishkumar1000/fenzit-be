import { ApiProperty } from '@nestjs/swagger';

export class EarlyAccessResponseDto {
  @ApiProperty({
    example: 'Thanks. We will email you when access opens.',
    description:
      'The same message whether the email is new or already on the list, so the response cannot be used to check who has signed up.',
  })
  message: string;

  @ApiProperty({
    example: 'FZ-3F9A0C21',
    description:
      'Random reference code for the visitor to keep. It does not count sign-ups. The same code for a repeat email.',
  })
  reference: string;
}
