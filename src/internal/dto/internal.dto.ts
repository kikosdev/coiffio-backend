import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ProvisionOwnerDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  email: string;

  @IsString()
  phone: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password?: string;
}

export class ProvisionTenantDto {
  /** Émis par le Control Plane — devient l'`_id` du document `salons` (clé d'idempotence). */
  @IsString()
  tenantId: string;

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  slug: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  plan?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => ProvisionOwnerDto)
  owner: ProvisionOwnerDto;
}

export class UpdateTenantStatusDto {
  @IsIn(['active', 'suspended', 'churned'])
  status: 'active' | 'suspended' | 'churned';
}

export class ImpersonateDto {
  @IsString()
  adminId: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  ttlMinutes?: number;
}
