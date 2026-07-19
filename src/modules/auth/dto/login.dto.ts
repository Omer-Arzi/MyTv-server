import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'The shared app password (APP_PASSWORD env var).' })
  @IsString()
  @IsNotEmpty()
  password: string;
}
