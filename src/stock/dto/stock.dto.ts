import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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

export class RestockDto {
  @IsNumber() @Min(1) qty: number;
  @IsOptional() @IsString() note?: string;
}

export class AdjustStockDto {
  @IsNumber() delta: number;
  @IsOptional() @IsString() note?: string;
}

export class ListProductsQueryDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsIn(['true', 'false']) activeOnly?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(['true', 'false']) inStock?: string;
}
