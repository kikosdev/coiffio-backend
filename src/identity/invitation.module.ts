import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Invitation, InvitationSchema } from './schemas/invitation.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { InvitationService } from './invitation.service';
import { InvitationController } from './invitation.controller';
import { IdentityModule } from './identity.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Module séparé de `IdentityModule` (bien que le SKILL range `invitation.service.ts` sous
 * `identity/` — juste l'emplacement des fichiers, pas le module Nest) : `AuthModule` importe
 * DÉJÀ `IdentityModule` (pour `MembershipService`) — si `IdentityModule` importait `AuthModule`
 * en retour pour `AuthService`, ce serait une dépendance circulaire entre modules. Un module
 * séparé qui importe les deux évite le problème sans `forwardRef()`.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Invitation.name, schema: InvitationSchema },
      { name: User.name, schema: UserSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: Salon.name, schema: SalonSchema },
    ]),
    IdentityModule,
    AuthModule,
    NotificationsModule,
  ],
  controllers: [InvitationController],
  providers: [InvitationService],
  exports: [InvitationService],
})
export class InvitationModule {}
