import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class SaleItemDto {
  @IsString() @IsNotEmpty() refId: string;
  @IsInt() @Min(1) qty: number;
}

export class SaleDiscountDto {
  @IsEnum(['amount', 'pct']) type: 'amount' | 'pct';
  @IsNumber() @Min(0) value: number;
}

export class CreateSaleDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SaleDiscountDto)
  discount?: SaleDiscountDto;

  @IsEnum(['cash', 'card'])
  method: 'cash' | 'card';
}

export class SalesQueryDto {
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  period?: 'day' | 'week' | 'month';

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

export class BestSellersQueryDto {
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  period?: 'day' | 'week' | 'month';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}
