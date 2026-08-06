import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { StaffRole } from '../../team/schemas/staff.schema';

const STAFF_ROLES = ['owner', 'manager', 'stylist', 'colorist'] as const;
const INVITATION_STATUSES = ['pending', 'accepted', 'expired', 'revoked'] as const;

export class CreateInvitationDto {
  // Email ou téléphone — normalisé serveur (`normalizeIdentifier`), cohérent avec `users.identifier`.
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  identifier: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsIn(STAFF_ROLES)
  role: StaffRole;

  @IsArray()
  @IsString({ each: true })
  locationIds: string[];
}

export class ListInvitationsQueryDto {
  @IsOptional()
  @IsIn(INVITATION_STATUSES)
  status?: (typeof INVITATION_STATUSES)[number];
}

export class AcceptInvitationDto {
  // Requis seulement si aucun `users` n'existe déjà pour cet identifier (cas cross-tenant :
  // un identifier qui correspond à un user existant réutilise son mot de passe actuel).
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password?: string;
}
