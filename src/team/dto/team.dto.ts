import { Type } from 'class-transformer';
import {
  ArrayMinSize,
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
import { DeclareDoseLineDto } from '../../loss-control/dto/dose-log.dto';

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

  /** Espèces remises par le client — archive le rendu de monnaie. Ignoré en carte. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  received?: number;
}

// ─── Vente POS libre (walk-in, sans rendez-vous) ─────────────────────────────

class PosSaleLineDto {
  @IsIn(['service', 'product'])
  kind: 'service' | 'product';

  @IsString()
  refId: string;

  @IsString()
  @MaxLength(160)
  name: string;

  @IsInt()
  @Min(1)
  qty: number;

  @IsNumber()
  @Min(0)
  unitPrice: number;
}

/**
 * Encaissement POS sans rendez-vous préexistant. `PosPayDto` couvre le cas "un RDV du board
 * est payé" (les lignes sont dérivées du RDV) ; celui-ci couvre le ticket composé à la main
 * au comptoir, où l'opérateur choisit le barbier et les lignes.
 */
export class PosSaleDto {
  @IsMongoId()
  stylistId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PosSaleLineDto)
  items: PosSaleLineDto[];

  @IsIn(['cash', 'card'])
  method: 'cash' | 'card';

  @IsOptional()
  @IsNumber()
  @Min(0)
  tip?: number;

  /** Espèces remises par le client — archive le rendu de monnaie. Ignoré en carte. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  received?: number;
}

/**
 * Encaissement walk-in qui ouvre son Appointment(source:'walkin') dans la MÊME transaction
 * (LC-0, SKILL_loss_control_doses.md Prompt 0-bis). `clientPhone` est requis — clé
 * merge-on-phone (#10), c'est l'ancrage LC-9. `clientName` optionnel, défaut "Client" côté
 * service. `PosSaleDto`/`POST /pos/sale` reste inchangé pour les tickets 100% produit (aucun
 * service rendu = rien à ancrer pour la déclaration de doses).
 */
export class PosSaleWithAppointmentDto {
  @IsMongoId()
  stylistId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PosSaleLineDto)
  items: PosSaleLineDto[];

  @IsIn(['cash', 'card'])
  method: 'cash' | 'card';

  @IsOptional()
  @IsNumber()
  @Min(0)
  tip?: number;

  /** Espèces remises par le client — archive le rendu de monnaie. Ignoré en carte. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  received?: number;

  @IsString()
  @MinLength(1)
  clientPhone: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  /** LC-3/A4 (Prompt 3-bis) : doses déclarées inline — ferme le trou "aucune fenêtre entre
   *  création et clôture" du walk-in atomique (LC-0). Même DTO de ligne que le POS standalone
   *  (`DeclareDoseLineDto`, loss-control), pas de duplication de schéma de validation. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeclareDoseLineDto)
  doses?: DeclareDoseLineDto[];
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
