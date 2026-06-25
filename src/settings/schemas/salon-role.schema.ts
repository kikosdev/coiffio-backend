import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SalonRoleDocument = SalonRole & Document;

/**
 * Sprint 10 — rôle salon (système ou personnalisé). Les rôles système (`isSystem:true`)
 * correspondent aux 4 rôles de l'enum `UserRole` (Decision #7 amended) et ne peuvent pas
 * être supprimés. Les rôles personnalisés (créés par l'owner) peuvent l'être.
 */
@Schema({ timestamps: true })
export class SalonRole {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: false, index: true })
  isSystem: boolean;

  @Prop({ type: [String], default: [] })
  permissions: string[];

  @Prop({ default: '#B89968' })
  color: string;
}

export const SalonRoleSchema = SchemaFactory.createForClass(SalonRole);
SalonRoleSchema.index({ salonId: 1, name: 1 }, { unique: true });
