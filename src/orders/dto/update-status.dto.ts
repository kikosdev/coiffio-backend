import { IsEnum, IsOptional, IsString } from 'class-validator';
import { OrderStatus } from '../schemas/order.schema';

export class UpdateStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdatePaymentDto {
  @IsEnum(['paid', 'unpaid', 'refunded'])
  paymentStatus: string;
}

export class UpdateNotesDto {
  @IsOptional()
  @IsString()
  internalNotes?: string;
}
