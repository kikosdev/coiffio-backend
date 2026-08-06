import { Type } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class NearbyQueryDto {
  @IsLatitude()
  @Type(() => Number)
  lat: number;

  @IsLongitude()
  @Type(() => Number)
  lng: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  radiusKm?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number;
}

export class ByRegionQueryDto {
  @IsString()
  @MaxLength(80)
  region: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number;
}

export class SalonAvailabilityQueryDto {
  @IsOptional()
  @IsMongoId()
  serviceId?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @IsOptional()
  @IsMongoId()
  locationId?: string;
}
