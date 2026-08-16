import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Notification, NotificationSchema } from './schemas/notification.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { NotificationsService } from './notifications.service';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsController } from './notifications.controller';

/** JwtModule est fourni globalement par CommonModule (utilisé au handshake gateway). */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: User.name, schema: UserSchema },
      { name: Staff.name, schema: StaffSchema },
    ]),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsGateway],
  // `NotificationsGateway` exporté (LC-10, Prompt 5) : `LossAlertService` a besoin d'émettre
  // sur son PROPRE modèle (`LossAlert`, pas `Notification`) via `roleRoom()` — le même canal
  // socket, une persistance différente. `NotificationsService.dispatch()` ne convient pas
  // (il persiste dans `notifications`, pas `lossalerts`).
  exports: [NotificationsService, NotificationsGateway],
})
export class NotificationsModule {}
