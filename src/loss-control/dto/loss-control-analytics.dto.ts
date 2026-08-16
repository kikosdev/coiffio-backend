import { IsIn, IsMongoId, IsOptional } from 'class-validator';

const PERIODS = ['day', 'week', 'month'] as const;
export type AnalyticsPeriod = (typeof PERIODS)[number];

export class StaffHonestyQueryDto {
  @IsOptional()
  @IsIn(PERIODS)
  period?: AnalyticsPeriod;

  @IsOptional()
  @IsMongoId()
  stylistId?: string;
}

export class VarianceQueryDto {
  @IsMongoId()
  productId: string;

  @IsOptional()
  @IsIn(PERIODS)
  period?: AnalyticsPeriod;
}

export class ExtremeUsageQueryDto {
  @IsOptional()
  @IsIn(PERIODS)
  period?: AnalyticsPeriod;
}
