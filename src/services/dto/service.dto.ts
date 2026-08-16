import {
  IsArray,
  IsHexColor,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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

/** LC-2 (SKILL_loss_control_doses.md) — théorique attendu, un service peut consommer plusieurs produits. */
export class DoseConfigEntryDto {
  @IsString()
  productId: string;

  @IsNumber()
  @Min(0.01)
  doses: number;
}

export class UpdateServiceDoseConfigDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DoseConfigEntryDto)
  doseConfig: DoseConfigEntryDto[];
}

export class ListServicesQueryDto {
  @IsOptional()
  @IsIn(GENDERS)
  gender?: 'men' | 'women' | 'universal';
}
