import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AddNoteDto {
  @ApiProperty({
    example: 'Great cliffhanger! Did not expect the twist with the captain.',
    maxLength: 2000,
    description: 'Free-form note text. Sending an empty-string-trimmed value is not allowed; delete via a future endpoint instead.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text: string;
}
