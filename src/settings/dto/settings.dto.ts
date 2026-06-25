import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BusinessHourDto {
  @IsInt() @Min(0) @Max(6)
  day: number;

  @IsBoolean()
  isOpen: boolean;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'start must be HH:MM' })
  start: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'end must be HH:MM' })
  end: string;
}

export class UpdateSalonDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(200)
  address?: string;

  @IsOptional() @IsString() @MaxLength(30)
  phone?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString()
  timezone?: string;

  @IsOptional() @IsString() @MaxLength(10)
  currency?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  taxRate?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BusinessHourDto)
  businessHours?: BusinessHourDto[];
}

export class CreateRoleDto {
  @IsString() @MinLength(2) @MaxLength(50)
  name: string;

  @IsArray()
  @IsString({ each: true })
  permissions: string[];

  @IsOptional() @IsString()
  color?: string;
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(50)
  name?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  permissions?: string[];

  @IsOptional() @IsString()
  color?: string;
}
