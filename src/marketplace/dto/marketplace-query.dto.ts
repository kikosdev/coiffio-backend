import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';

export class SearchServicesQueryDto {
  @IsString()
  @MinLength(2)
  q: string;
}

export class OfferingsQueryDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString({ each: true })
  categories?: string | string[];

  @IsOptional()
  @IsString({ each: true })
  'categories[]'?: string | string[];

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString({ each: true })
  names?: string | string[];

  @IsOptional()
  @IsString({ each: true })
  'names[]'?: string | string[];

  @IsOptional()
  @IsString({ each: true })
  serviceIds?: string | string[];

  @IsOptional()
  @IsString({ each: true })
  'serviceIds[]'?: string | string[];

  @IsOptional()
  @IsIn(['all', 'any'])
  match?: 'all' | 'any';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lng?: number;
}
