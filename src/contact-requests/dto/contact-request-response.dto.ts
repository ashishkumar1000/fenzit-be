import { ApiProperty } from '@nestjs/swagger';

export class ContactRequestResponseDto {
  @ApiProperty({
    example: 'Thanks. We will call you back on the number you gave.',
    description: 'Tells the person what happens next, by request kind.',
  })
  message: string;
}
