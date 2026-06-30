import {
  IsHexColor,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const GENDERS = ['men', 'women', 'universal'] as const;

export class CreateServiceDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsIn(GENDERS)
  gender: 'men' | 'women' | 'universal';

  @IsNumber()
  @Min(0)
  price: number;

  @IsInt()
  @Min(0)
  durationMin: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bufferMin?: number;

  @IsOptional()
  @IsHexColor()
  color?: string;
}

export class UpdateServiceDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsIn(GENDERS)
  gender?: 'men' | 'women' | 'universal';

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bufferMin?: number;

  @IsOptional()
  @IsHexColor()
  color?: string;
}

export class ListServicesQueryDto {
  @IsOptional()
  @IsIn(GENDERS)
  gender?: 'men' | 'women' | 'universal';
}
