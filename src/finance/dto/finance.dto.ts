import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsIn, IsMongoId, IsNumber, IsOptional, IsString, Matches, Min, ValidateNested,
} from 'class-validator';

class PaymentLineDto {
  @IsIn(['service', 'product']) kind: 'service' | 'product';
  @IsString() refId: string;
  @IsString() name: string;
  @IsNumber() @Min(0) qty: number;
  @IsNumber() @Min(0) unitPrice: number;
}

export class CreatePaymentDto {
  @IsOptional() @IsMongoId() appointmentId?: string;
  @IsMongoId() stylistId: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PaymentLineDto) items: PaymentLineDto[];
  @IsOptional() @IsNumber() @Min(0) tip?: number;
  @IsIn(['cash', 'card']) method: 'cash' | 'card';
  /** Espèces remises par le client — sert à archiver le rendu de monnaie. Ignoré en carte. */
  @IsOptional() @IsNumber() @Min(0) received?: number;
}

export class CreateExpenseDto {
  @IsString() category: string;
  @IsNumber() @Min(0) amount: number;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  @IsOptional() @IsString() note?: string;
}

export class UpdateExpenseDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  @IsOptional() @IsString() note?: string;
}

export class ReportsQueryDto {
  @IsOptional() @IsIn(['day', 'week', 'month']) period?: 'day' | 'week' | 'month';
}

export class EarningsQueryDto {
  @IsOptional() @IsIn(['week', 'month', 'year']) period?: 'week' | 'month' | 'year';
}
