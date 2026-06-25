import { IsBoolean, IsEmail, IsIn, IsMongoId, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class AddCartItemDto {
  @IsMongoId() productId: string;
  @IsNumber() @Min(1) qty: number;
}

export class CheckoutDto {
  @IsString() name: string;
  @IsString() phone: string;
  @IsEmail() email: string;
  @IsOptional() @IsString() pickupAt?: string;
  @IsOptional() @IsBoolean() delivery?: boolean;
}

export class UpdateCartItemDto {
  @IsNumber() @Min(0) qty: number;
}

export class UpdateOrderStatusDto {
  @IsIn(['pending', 'confirmed', 'ready', 'picked_up', 'cancelled'])
  status: 'pending' | 'confirmed' | 'ready' | 'picked_up' | 'cancelled';
}
