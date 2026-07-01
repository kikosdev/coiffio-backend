import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** GET /availability?serviceId=&date=YYYY-MM-DD[&serviceIds=a,b] */
export class AvailabilityQueryDto {
  // Un service simple…
  @IsOptional()
  @IsMongoId()
  serviceId?: string;

  // …ou plusieurs services chaînés (durée sommée, un seul stylist, un groupId — #3).
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  @Type(() => String)
  serviceIds?: string[];

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date YYYY-MM-DD' })
  date: string;

  @IsOptional()
  @IsMongoId()
  stylistId?: string; // restreindre à un stylist précis
}

/** GET /availability/timeline?serviceIds=a,b&startDate=YYYY-MM-DD&days=7 — vue multi-jours (#1 live, par jour). */
export class AvailabilityTimelineQueryDto {
  @IsOptional()
  @IsMongoId()
  serviceId?: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  @Type(() => String)
  serviceIds?: string[];

  // Premier jour de la fenêtre ; défaut = aujourd'hui.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate YYYY-MM-DD' })
  startDate?: string;

  @IsOptional()
  @IsMongoId()
  stylistId?: string;

  // Taille de la fenêtre (jours) ; défaut = 7, plafonné pour éviter une charge excessive.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  days?: number;
}

export class CreateAppointmentDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsMongoId({ each: true })
  serviceIds: string[];

  @IsMongoId()
  stylistId: string;

  // Client existant…
  @IsOptional()
  @IsMongoId()
  clientId?: string;

  // …ou résolution merge-on-phone (#10) : nom + phone + email (email mandatoire #11).
  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsString()
  clientPhone?: string;

  @IsOptional()
  @IsEmail()
  clientEmail?: string;

  // Début ISO du créneau (l'engine recalcule la fin via durée+buffer).
  @IsString()
  start: string;

  // online (public storefront) ou phone (staff). walkin a son endpoint dédié.
  @IsOptional()
  @IsIn(['online', 'phone'])
  source?: 'online' | 'phone';
}

/** Walk-in : création staff SANS check de dispo (peut chevaucher — décision design). */
export class CreateWalkinDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsMongoId({ each: true })
  serviceIds: string[];

  @IsMongoId()
  stylistId: string;

  @IsOptional()
  @IsMongoId()
  clientId?: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsString()
  clientPhone?: string;

  @IsOptional()
  @IsEmail()
  clientEmail?: string;

  // Optionnel : sinon, "maintenant".
  @IsOptional()
  @IsString()
  start?: string;
}

export class CancelAppointmentDto {
  // Annulation client via lien signé (pas de JWT) — décision #12.
  @IsOptional()
  @IsString()
  token?: string;
}

export class MineQueryDto {
  @IsOptional()
  @IsIn(['upcoming', 'history'])
  scope?: 'upcoming' | 'history';
}

export class ListAppointmentsQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @IsOptional()
  @IsMongoId()
  stylistId?: string;
}
