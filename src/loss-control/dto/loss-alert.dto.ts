import { IsIn, IsOptional } from 'class-validator';

export class ListLossAlertsQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  read?: string;

  @IsOptional()
  @IsIn(['stock_variance', 'staff_honesty', 'extreme_usage'])
  kind?: 'stock_variance' | 'staff_honesty' | 'extreme_usage';
}
