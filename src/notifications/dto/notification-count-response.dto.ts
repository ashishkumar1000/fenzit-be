import { ApiProperty } from '@nestjs/swagger';

export class UnreadCountResponse {
  @ApiProperty({ example: 3 })
  unreadCount: number;
}

export class MarkReadResponse {
  @ApiProperty({
    example: 1,
    description: 'Rows actually marked (own + previously unread only)',
  })
  markedCount: number;
}
