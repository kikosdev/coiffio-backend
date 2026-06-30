import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateClientDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @MinLength(4)
  @MaxLength(32)
  phone: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsBoolean()
  commsConsent?: boolean;

  @IsOptional()
  @IsIn(['email', 'sms'])
  preferredChannel?: 'email' | 'sms';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateClientDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsBoolean()
  commsConsent?: boolean;

  @IsOptional()
  @IsIn(['email', 'sms'])
  preferredChannel?: 'email' | 'sms';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ListClientsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}
