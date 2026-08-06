import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Appointment, AppointmentSchema } from './schemas/appointment.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import { Schedule, ScheduleSchema } from '../team/schemas/schedule.schema';
import { StaffProfile, StaffProfileSchema } from '../team/schemas/staff-profile.schema';
import { Client, ClientSchema } from '../clients/schemas/client.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { BookingService } from './booking.service';
import { BookingController } from './booking.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { IdentityModule } from '../identity/identity.module';
import { LocationsModule } from '../locations/locations.module';
import { TenantModule } from '../common/tenant/tenant.module';

@Module({
  imports: [
    NotificationsModule,
    IdentityModule,
    LocationsModule,
    TenantModule,
    MongooseModule.forFeature([
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: Schedule.name, schema: ScheduleSchema },
      { name: StaffProfile.name, schema: StaffProfileSchema },
      { name: Client.name, schema: ClientSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: Salon.name, schema: SalonSchema },
    ]),
  ],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService, MongooseModule],
})
export class BookingModule {}
