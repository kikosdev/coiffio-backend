import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { Location, LocationSchema } from '../locations/schemas/location.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Schedule, ScheduleSchema } from '../team/schemas/schedule.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import { Appointment, AppointmentSchema } from '../booking/schemas/appointment.schema';
import { InternalController } from './internal.controller';
import { InternalService } from './internal.service';
import { IdentityModule } from '../identity/identity.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Salon.name, schema: SalonSchema },
      { name: Location.name, schema: LocationSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: User.name, schema: UserSchema },
      { name: Schedule.name, schema: ScheduleSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: Appointment.name, schema: AppointmentSchema },
    ]),
    IdentityModule,
    EmailModule,
  ],
  controllers: [InternalController],
  providers: [InternalService],
})
export class InternalModule {}
