import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;
}

export class RegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(4)
  @MaxLength(32)
  phone: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;
}

export class PasswordResetRequestDto {
  @IsEmail()
  email: string;
}

export class PasswordResetConfirmDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  currentPassword: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  newPassword: string;
}

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsBoolean()
  commsConsent?: boolean;
}
