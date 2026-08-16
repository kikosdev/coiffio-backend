import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class DeclareDoseLineDto {
  @IsString()
  productId: string;

  @IsNumber()
  @Min(0)
  dosesDeclared: number;
}

/**
 * Corps enveloppé (`{lines: [...]}`), pas un tableau brut au niveau racine — le
 * `ValidationPipe` global (`whitelist:true, transform:true`) ne valide pas un body-array de
 * DTOs sans passerelle dédiée (`ParseArrayPipe`, jamais utilisée dans ce codebase). Même
 * convention que `PosSaleDto.items` / `UpdateServiceDoseConfigDto.doseConfig`.
 */
export class DeclareDosesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DeclareDoseLineDto)
  lines: DeclareDoseLineDto[];
}

/** Correction owner-only, réservée aux déclarations déjà verrouillées (LC-4). */
export class CorrectDoseLogDto {
  @IsNumber()
  @Min(0)
  dosesDeclared: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  correctionNote: string;
}
