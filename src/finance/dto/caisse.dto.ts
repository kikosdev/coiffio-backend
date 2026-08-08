import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { CASH_MOVEMENT_REASONS, CashMovementReason, CashMovementType } from '../schemas/cash-movement.schema';

export class CaisseDayQueryDto {
  /** 'YYYY-MM-DD' Africa/Tunis. Absent → aujourd'hui. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}

export class CaisseHistoryQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) limit?: number;
}

export class OpenSessionDto {
  @IsNumber() @Min(0) openingFloat: number;
  @IsOptional() @IsString() @MaxLength(280) note?: string;
}

export class CreateCashMovementDto {
  @IsIn(['in', 'out']) type: CashMovementType;
  /** Toujours positif — le sens vient de `type` (cf. docstring du schéma). */
  @IsNumber() @Min(0.001) amount: number;
  @IsOptional() @IsIn(CASH_MOVEMENT_REASONS) reason?: CashMovementReason;
  @IsOptional() @IsString() @MaxLength(280) note?: string;
}

export class CloseSessionDto {
  /** Espèces réellement comptées dans le tiroir. */
  @IsNumber() @Min(0) countedTotal: number;
  @IsOptional() @IsString() @MaxLength(280) note?: string;
}
