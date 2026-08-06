import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { StaffRole } from '../../team/schemas/staff.schema';

export type InvitationDocument = Invitation & Document;

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

/**
 * `Invitation` — Sprint 2 v2 Prompt 5. Le self-register staff est bloqué (`POST /team` et
 * `POST /auth/staff` sont owner-only) — c'est le mécanisme par lequel un owner/manager fait
 * REJOINDRE quelqu'un d'autre à son tenant, en réutilisant `MembershipService.grant()`
 * (Prompt 3) pour la création réelle du profil staff + du membership à l'acceptation.
 *
 * `salonId` : String brut (Invariant #1) — nommé `salonId`, PAS `tenantId` comme
 * `Membership` : `invitations` est TENANT_SCOPED (`scoping-registry.ts`), et le plugin de
 * scope tenant (`tenant-scope.plugin.ts`) attend littéralement ce nom de champ pour
 * l'injection/filtrage automatique sur toute collection TENANT_SCOPED — `Membership` s'appelle
 * `tenantId` uniquement parce qu'il est GLOBAL (exempté du plugin, jamais scopé
 * automatiquement). Confondre les deux fait échouer silencieusement toute lecture Mongoose
 * scopée (trouvé en écrivant les tests de ce prompt : `findById` renvoyait `null` pour une
 * invitation pourtant bien présente en base, le plugin filtrant sur un `salonId` absent).
 *
 * `tokenHash` : `select:false` — le token clair (32 bytes aléatoires) n'existe QUE le temps
 * de sa génération (loggé comme lien "envoyé", jamais renvoyé par l'API — même principe que
 * `AuthService.requestPasswordReset()`), jamais stocké ni renvoyé en clair.
 */
@Schema({ timestamps: true })
export class Invitation {
  @Prop({ type: String, required: true, index: true })
  salonId: string;

  // Email OU téléphone — cohérent avec `users.identifier`/`identifierType`.
  @Prop({ required: true, index: true })
  identifier: string;

  @Prop({ type: String, enum: ['email', 'phone'], required: true })
  identifierType: 'email' | 'phone';

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, enum: ['owner', 'manager', 'stylist', 'colorist'], required: true })
  role: StaffRole;

  @Prop({ type: [String], default: [] })
  locationIds: string[];

  @Prop({ type: String, required: true, select: false })
  tokenHash: string;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  @Prop({ type: String, enum: ['pending', 'accepted', 'expired', 'revoked'], default: 'pending' })
  status: InvitationStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  invitedBy: Types.ObjectId;

  @Prop({ type: Date })
  acceptedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'Membership' })
  membershipId?: Types.ObjectId;
}

export const InvitationSchema = SchemaFactory.createForClass(Invitation);

InvitationSchema.index({ salonId: 1, identifier: 1, status: 1 });
// Housekeeping seulement — la validité réelle (410) est vérifiée explicitement contre
// `expiresAt`/`status` à la lecture (`getByToken`/`accept`), jamais en s'appuyant sur le
// délai du moniteur TTL de MongoDB (jusqu'à 60s), qui ne serait pas fiable pour une réponse
// HTTP immédiate.
InvitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
