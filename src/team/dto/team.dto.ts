import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const STAFF_ROLES = ['manager', 'stylist', 'colorist'] as const;
const LEVELS = ['master', 'senior', 'apprentice'] as const;

// ─── Staff accounts + StaffProfile ───────────────────────────────────────────

export class CreateStaffDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @MaxLength(160)
  email: string;

  @IsString()
  @MinLength(4)
  @MaxLength(32)
  phone: string;

  @IsIn(STAFF_ROLES)
  role: 'manager' | 'stylist' | 'colorist';

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  // StaffProfile (optionnel à la création — surtout pour les stylists).
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

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsIn(STAFF_ROLES)
  role?: 'manager' | 'stylist' | 'colorist';

  @IsOptional()
  @Type(() => Boolean)
  isActive?: boolean;

  @IsOptional()
  @IsHexColor()
  color?: string;

  // Présent uniquement pour lever une 400 explicite si le client tente de changer de salon.
  @IsOptional()
  @IsMongoId()
  salonId?: string;

  // StaffProfile (level / capabilities / paie) — owner·manager (matrice).
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

export class SetAcceptingBookingsDto {
  @IsBoolean()
  acceptingBookings: boolean;
}

export class UpdateStaffLocationsDto {
  @IsArray()
  @IsString({ each: true })
  locationIds: string[];
}

export class PosPayDto {
  @IsIn(['cash', 'card'])
  method: 'cash' | 'card';
}

// ─── Schedule (weekly rota + overrides) ──────────────────────────────────────

class BreakDto {
  @Matches(HHMM, { message: 'break.start HH:mm' })
  start: string;

  @Matches(HHMM, { message: 'break.end HH:mm' })
  end: string;
}

class WeeklyShiftDto {
  @IsInt()
  @Min(0)
  @Max(6)
  day: number;

  @Matches(HHMM, { message: 'start HH:mm' })
  start: string;

  @Matches(HHMM, { message: 'end HH:mm' })
  end: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BreakDto)
  breaks?: BreakDto[];
}

export class SetWeeklyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyShiftDto)
  weekly: WeeklyShiftDto[];
}

export class AddOverrideDto {
  @Matches(YMD, { message: 'date YYYY-MM-DD' })
  date: string;

  @IsIn(['off', 'leave', 'custom'])
  type: 'off' | 'leave' | 'custom';

  @IsOptional()
  @Matches(HHMM)
  start?: string;

  @IsOptional()
  @Matches(HHMM)
  end?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

// ─── Leave / swap requests ───────────────────────────────────────────────────

class LeaveRangeDto {
  @Matches(YMD, { message: 'range.from YYYY-MM-DD' })
  from: string;

  @Matches(YMD, { message: 'range.to YYYY-MM-DD' })
  to: string;
}

export class CreateLeaveRequestDto {
  @IsOptional()
  @IsMongoId()
  stylistId?: string; // owner/manager peut déposer pour un stylist ; sinon = soi-même

  @IsIn(['leave', 'swap'])
  type: 'leave' | 'swap';

  @ValidateNested()
  @Type(() => LeaveRangeDto)
  range: LeaveRangeDto;

  @IsOptional()
  @IsMongoId()
  swapWithId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListLeaveQueryDto {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: 'pending' | 'approved' | 'rejected';
}
