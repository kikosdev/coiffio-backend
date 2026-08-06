import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MembershipDocument = Membership & Document;

export type MembershipKind = 'staff' | 'client';
export type MembershipRole = 'owner' | 'manager' | 'stylist' | 'colorist' | 'client';
export type MembershipStatus = 'active' | 'invited' | 'suspended' | 'revoked';

/**
 * `Membership` — Sprint 2 v2 Prompt 1. Rend EXPLICITE le lien user→tenant→role que
 * `staffs.salonId`/`staffs.role` (ou `clients.salonId`) portaient jusqu'ici de façon
 * implicite (déduit par lookup, jamais stocké tel quel). GLOBAL (hors scope tenant,
 * `scoping-registry.ts`) — lu cross-tenant par `userId` pour résoudre les tenants d'un
 * user, mais toute requête backoffice DOIT filtrer explicitement par `tenantId`.
 *
 * `role` est TOUJOURS projeté depuis `staffs.role` (autoritaire), jamais `users.role`
 * (catégorie large `owner|staff|client`, pas le rôle applicatif) — audit Sprint 2 confirmé,
 * voir `migrate-create-memberships.ts`.
 */
@Schema({ timestamps: true })
export class Membership {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  // = salonId, String brut (Invariant #1) — jamais un Types.ObjectId, garde-fou plugin actif
  // même si `memberships` est GLOBAL (exempté du scope, mais pas de l'invariant de forme).
  @Prop({ type: String, required: true, index: true })
  tenantId: string;

  @Prop({ type: String, enum: ['staff', 'client'], required: true })
  kind: MembershipKind;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  staffId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Client' })
  clientId?: Types.ObjectId;

  @Prop({ type: String, enum: ['owner', 'manager', 'stylist', 'colorist', 'client'], required: true })
  role: MembershipRole;

  @Prop({ type: [String], default: [] })
  locationIds: string[];

  @Prop({ type: String })
  defaultLocationId?: string;

  @Prop({ type: String, enum: ['active', 'invited', 'suspended', 'revoked'], default: 'active' })
  status: MembershipStatus;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  invitedBy?: Types.ObjectId;

  @Prop({ type: Date })
  invitedAt?: Date;

  @Prop({ type: Date })
  acceptedAt?: Date;

  @Prop({ type: Date })
  revokedAt?: Date;
}

export const MembershipSchema = SchemaFactory.createForClass(Membership);

// Un seul membership par (user, tenant) — un user a AU PLUS un rôle par tenant.
MembershipSchema.index({ userId: 1, tenantId: 1 }, { unique: true });
MembershipSchema.index({ tenantId: 1, role: 1 });
MembershipSchema.index({ staffId: 1 });
MembershipSchema.index({ tenantId: 1, status: 1 });

// kind='staff' ⇒ staffId requis · kind='client' ⇒ clientId requis (spec Sprint 2 Prompt 1).
MembershipSchema.pre('validate', function (next) {
  if (this.kind === 'staff' && !this.staffId) {
    next(new Error("Membership.staffId is required when kind='staff'."));
    return;
  }
  if (this.kind === 'client' && !this.clientId) {
    next(new Error("Membership.clientId is required when kind='client'."));
    return;
  }
  next();
});
