import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UserDocument = User & Document;

export type UserRole = 'client';

/**
 * Collection `User` — clients uniquement. Staff (owner/manager/stylist/colorist) vivent
 * dans la collection `Staff`. `passwordHash` absent ⇒ client invité (Décision #10).
 * `phone` est la clé d'identité côté client (merge-on-phone). `salonId` présent partout.
 */
@Schema({ timestamps: true })
export class User {
  @Prop({ type: Types.ObjectId, ref: 'Salon', required: true, index: true })
  salonId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  // email indexé unique (Décision #11 : email mandatoire)
  @Prop({ required: true, lowercase: true, trim: true, unique: true, index: true })
  email: string;

  // phone indexé — clé d'identité client (Décision #10)
  @Prop({ default: '', index: true })
  phone: string;

  // absent ⇒ guest ; défini ⇒ compte registered
  @Prop()
  passwordHash?: string;

  @Prop({
    type: String,
    enum: ['client'],
    default: 'client',
    index: true,
  })
  role: UserRole;

  @Prop({ default: true })
  isActive: boolean;

  // true dès qu'un passwordHash est défini (compte exploitable au login)
  @Prop({ default: false })
  registered: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
