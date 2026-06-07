import {
  IsString, IsEnum, IsInt, IsNumber, IsOptional,
  MinLength, Min, Max, MaxLength, Matches, IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ServiceCategory } from '../../schemas/service.schema';
import { StaffJob } from '../../schemas/user.schema';

export class CreateServiceDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsEnum(ServiceCategory)
  category: ServiceCategory;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsInt()
  @Min(5)
  @Max(600)
  @Type(() => Number)
  duration: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  costPrice?: number;

  @IsOptional()
  @IsString()
  @Matches(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, { message: 'color must be a valid hex color' })
  color?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(StaffJob, { each: true })
  requiredJobs?: StaffJob[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  bufferBefore?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  bufferAfter?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  displayOrder?: number;
}
