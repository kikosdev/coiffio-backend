import {
  IsBoolean,
  IsIn,
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

export class LocationAddressDto {
  @IsOptional() @IsString() @MaxLength(200)
  line1?: string;

  @IsOptional() @IsString() @MaxLength(100)
  city?: string;

  @IsOptional() @IsString() @MaxLength(20)
  postalCode?: string;

  @IsOptional() @IsString() @MaxLength(100)
  country?: string;

  @IsOptional() @IsNumber()
  lat?: number;

  @IsOptional() @IsNumber()
  lng?: number;
}

export class OpeningHoursEntryDto {
  @IsInt() @Min(0) @Max(6)
  day: number;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'open must be HH:MM' })
  open: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'close must be HH:MM' })
  close: string;

  @IsBoolean()
  closed: boolean;
}

export class CreateLocationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase alphanumeric with dashes only' })
  slug: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocationAddressDto)
  address?: LocationAddressDto;

  @IsOptional() @IsString() @MaxLength(30)
  phone?: string;

  @IsOptional() @IsString()
  timezone?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursEntryDto)
  openingHours?: OpeningHoursEntryDto[];

  @IsOptional() @IsString() @MaxLength(80)
  region?: string;
}

export class UpdateLocationDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase alphanumeric with dashes only' })
  slug?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocationAddressDto)
  address?: LocationAddressDto;

  @IsOptional() @IsString() @MaxLength(30)
  phone?: string;

  @IsOptional() @IsString()
  timezone?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursEntryDto)
  openingHours?: OpeningHoursEntryDto[];

  @IsOptional() @IsString() @MaxLength(80)
  region?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class ListLocationsQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  active?: string;
}
