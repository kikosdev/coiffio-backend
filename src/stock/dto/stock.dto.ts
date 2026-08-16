import { IsBoolean, IsIn, IsMongoId, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateProductDto {
  @IsString() name: string;
  @IsOptional() @IsString() category?: string;
  @IsNumber() @Min(0) price: number;
  @IsOptional() @IsNumber() @Min(0) cost?: number;
  @IsOptional() @IsNumber() @Min(0) stock?: number;
  @IsOptional() @IsNumber() @Min(0) lowStockAt?: number;
  @IsOptional() @IsString() supplier?: string;
  @IsOptional() @IsString() @MaxLength(64) barcode?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class UpdateProductDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsNumber() @Min(0) cost?: number;
  @IsOptional() @IsNumber() @Min(0) lowStockAt?: number;
  @IsOptional() @IsString() supplier?: string;
  @IsOptional() @IsString() @MaxLength(64) barcode?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsBoolean() visibleLanding?: boolean;
  @IsOptional() @IsBoolean() promo?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(90) promoPercent?: number;
  @IsOptional() @IsString() promoLabel?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** LC-1/LC-7 (SKILL_loss_control_doses.md) — owner-only, séparé de `UpdateProductDto`. */
export class UpdateProductDosesDto {
  @IsOptional() @IsNumber() @Min(0) dosesPerUnit?: number;
  @IsOptional() @IsBoolean() isConsumable?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(100) varianceThresholdPct?: number;
}

export class RestockDto {
  @IsNumber() @Min(1) qty: number;
  @IsOptional() @IsString() note?: string;
}

export class AdjustStockDto {
  @IsNumber() delta: number;
  @IsOptional() @IsString() note?: string;
}

/**
 * LC-5 (SKILL_loss_control_doses.md, Prompt 3) — POS (`PosScopeGuard`), refill/adjustment/loss.
 * `units` : magnitude POSITIVE pour `refill`/`loss` (le serveur applique le sens), signée pour
 * `adjustment` (correction libre, peut aller dans les deux sens).
 */
export class CreateStockMovementDto {
  @IsMongoId()
  productId: string;

  @IsIn(['refill', 'adjustment', 'loss'])
  kind: 'refill' | 'adjustment' | 'loss';

  @IsNumber()
  units: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * LC-5 — INVENTAIRE PHYSIQUE (Prompt 3). `countedStock` est une VALEUR ABSOLUE constatée,
 * jamais un delta — c'est le point de vérité qui rend Calc 2 (Prompt 4) opérant.
 */
export class CreateInventoryCountDto {
  @IsMongoId()
  productId: string;

  @IsNumber()
  @Min(0)
  countedStock: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListStockMovementsQueryDto {
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  period?: 'day' | 'week' | 'month';

  @IsOptional()
  @IsMongoId()
  productId?: string;
}

export class ListProductsQueryDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsIn(['true', 'false']) activeOnly?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(['true', 'false']) inStock?: string;
}
