import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';
import { trim } from '../../common/utils/trim.transformer';

export class LookupUserQueryDto {
  @ApiProperty({
    description: 'Indian mobile number to look up (10 digits, optional 91/+91 prefix)',
    example: '98765 43210',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'phone is required' })
  phone: string;
}
