import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsIn, IsInt, IsMongoId, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// ─── Avances ──────────────────────────────────────────────────────────────

export class CreateAdvanceDto {
  // Requis quand l'owner accorde une avance ; ignoré (remplacé par soi-même) côté staff.
  @IsOptional()
  @IsMongoId()
  staffId?: string;

  // Millimes.
  @IsNumber()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class DecideAdvanceDto {
  @IsIn(['approve', 'reject'])
  decision: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  rejectedReason?: string;
}

export class ListAdvancesQueryDto {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'settled'])
  status?: 'pending' | 'approved' | 'rejected' | 'settled';

  @IsOptional()
  @IsMongoId()
  staffId?: string;
}

// ─── Paie ─────────────────────────────────────────────────────────────────

export class PayrollPreviewQueryDto {
  @IsMongoId()
  staffId: string;

  @IsInt()
  @Min(2020)
  @Max(2100)
  @Type(() => Number)
  year: number;

  @IsInt()
  @Min(1)
  @Max(12)
  @Type(() => Number)
  month: number;
}

export class ListPayrollQueryDto {
  // Les deux restent ensemble : soit aucune des deux (historique cross-période d'un staff via
  // `staffId`), soit les deux (overview salon d'un mois donné) — jamais un seul des deux, ça ne
  // correspond à aucun cas d'usage réel (mobile Prompt 6/7).
  @IsOptional()
  @IsInt()
  @Min(2020)
  @Max(2100)
  @Type(() => Number)
  year?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  @Type(() => Number)
  month?: number;

  // Historique d'UN staff, toutes périodes (mobile Prompt 6, StaffPayrollTab "Historique") —
  // sans staffId, comportement inchangé (overview salon du mois demandé, Prompt 7).
  @IsOptional()
  @IsMongoId()
  staffId?: string;
}

export class CreatePayrollDto {
  @IsMongoId()
  staffId: string;

  @IsInt()
  @Min(2020)
  @Max(2100)
  year: number;

  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  // Millimes.
  @IsOptional()
  @IsNumber()
  @Min(0)
  bonus?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  deductions?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  settleAdvanceIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
