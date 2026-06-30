import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

export type UserRole = 'owner' | 'staff' | 'client';

/**
 * Collection `users` — IDENTITÉ uniquement (Identity Service futur).
 * Centralise les credentials de tous les rôles. Profils métier (`clients`, `staffs`)
 * sont liés par userId et restent dans leurs propres collections.
 */
@Schema({ timestamps: true })
export class User {
  // Login identifier : email normalisé OU téléphone canonique (+216...).
  // Unique tous rôles confondus — clé d'authentification.
  @Prop({ required: true, unique: true, index: true })
  identifier: string;

  @Prop({ type: String, enum: ['email', 'phone'], required: true })
  identifierType: 'email' | 'phone';

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ type: String, enum: ['owner', 'staff', 'client'], required: true, index: true })
  role: UserRole;

  @Prop({ default: true })
  isActive: boolean;

  // Expo push token — mobile notifications (cf. SKILL notifications)
  @Prop()
  expoPushToken?: string;

  @Prop({ default: null })
  lastLoginAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
