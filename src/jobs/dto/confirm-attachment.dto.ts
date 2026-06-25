import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class ConfirmAttachmentDto {
  @ApiProperty({
    description: 'File size in bytes reported by the client after upload',
  })
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
