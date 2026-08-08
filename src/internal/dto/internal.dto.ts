import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
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

  /** [P4] Libellé d'emplacement, purement d'affichage — distingue deux tenants homonymes
   *  ("Joshef Coif — Ezzahra"). Aucune unicité, aucun scope : voir `Salon.locationLabel`
   *  pour la distinction avec `locationId`/`region`, qui sont d'autres axes. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  locationLabel?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => ProvisionOwnerDto)
  owner: ProvisionOwnerDto;

  /**
   * [P3 owner multi-salon — DÉCISION 8, rattachement EXPLICITE] Rattache ce nouveau tenant à
   * un compte owner DÉJÀ EXISTANT au lieu d'en créer un.
   *
   * Le DP ne réutilise JAMAIS un compte sur la seule présence de l'email : sans ce flag, un
   * email déjà connu reste un refus (409 `OWNER_EMAIL_TAKEN`, P1). C'est ce qui empêche une
   * faute de frappe côté CP de rattacher silencieusement un salon au mauvais propriétaire.
   */
  @IsOptional()
  @IsBoolean()
  attachToExistingOwner?: boolean;

  /** Requis quand `attachToExistingOwner === true` — résolu par le CP via
   *  `GET /internal/owners/lookup` (P2). Même pattern de dépendance conditionnelle que
   *  `dataPlaneUrl` côté `CreateTenantDto` du CP. */
  @ValidateIf((o: ProvisionTenantDto) => o.attachToExistingOwner === true)
  @IsMongoId()
  ownerUserId?: string;
}

/**
 * [P2 owner multi-salon] Query de `GET /internal/owners/lookup`. `identifier` est un email OU
 * un téléphone brut — normalisé côté serveur (`normalizeIdentifier`), jamais fait confiance à
 * la casse/au format envoyés par le CP, exactement comme `login()` et `InvitationService`.
 */
export class OwnerLookupQueryDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  identifier: string;
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
