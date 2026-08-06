import {
  IsArray,
  IsEmail,
  IsHexColor,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { StaffRole } from '../../team/schemas/staff.schema';

const STAFF_ROLES = ['manager', 'stylist', 'colorist'] as const;
const LEVELS = ['master', 'senior', 'apprentice'] as const;

export class LoginDto {
  // Email OU téléphone — le backend détecte le type via normalizeIdentifier().
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  identifier: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;
}

export class RegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  // Identifiant de login (email ou téléphone).
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  identifier: string;

  // Téléphone TOUJOURS requis (clé d'identité client, merge-on-phone).
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  phone: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;

  // Sprint 2 v2 Prompt 4 — utilisé seulement si le sous-domaine du Host ne résout rien
  // (voir `extractTenantSlugFromHost` — no-op en dev/localhost). Remplace l'ancien fallback
  // DEFAULT_SALON_ID : sans slug résolu (ni sous-domaine ni ce champ), 404 propre.
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  salonSlug?: string;
}

export class CreateStaffAuthDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  // Identifiant de login du nouveau staff (email ou téléphone).
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  identifier: string;

  @IsIn(STAFF_ROLES)
  role: 'manager' | 'stylist' | 'colorist';

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsIn(LEVELS)
  level?: 'master' | 'senior' | 'apprentice';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capabilities?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  baseRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionPct?: number;
}

export class PasswordResetRequestDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  identifier: string;
}

export class PasswordResetConfirmDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  currentPassword: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  newPassword: string;
}

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  phone?: string;
}

export class UpdateExpoPushTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  expoPushToken?: string | null;
}

export class LoginPinDto {
  @IsString()
  @Length(24, 24)
  staffId: string;

  @IsString()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'PIN must be exactly 4 digits.' })
  pin: string;
}

export class SwitchTenantDto {
  @IsString()
  tenantId: string;
}

export interface PosTokenPayload {
  staffId: string;
  salonId: string;
  scope: 'pos';
  // Ajouté pour combler un trou trouvé au Prompt 6b : sans ce champ, TenantContextMiddleware
  // (qui lit `payload.role` indistinctement du type de token) résolvait `role: undefined`
  // pour toute requête POS — TenantContext.role jamais fiable pour ce chemin.
  role: StaffRole;
}
