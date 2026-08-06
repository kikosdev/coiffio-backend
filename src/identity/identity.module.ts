import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClientProfile, ClientProfileSchema } from './schemas/client-profile.schema';
import { Membership, MembershipSchema } from './schemas/membership.schema';
import { Client, ClientSchema } from '../clients/schemas/client.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { Appointment, AppointmentSchema } from '../booking/schemas/appointment.schema';
import { LocationsModule } from '../locations/locations.module';
import { ClientProfileService } from './client-profile.service';
import { MembershipService } from './membership.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ClientProfile.name, schema: ClientProfileSchema },
      { name: Membership.name, schema: MembershipSchema },
      { name: Client.name, schema: ClientSchema },
      { name: Salon.name, schema: SalonSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: Appointment.name, schema: AppointmentSchema },
    ]),
    LocationsModule,
  ],
  providers: [ClientProfileService, MembershipService],
  exports: [ClientProfileService, MembershipService, MongooseModule],
})
export class IdentityModule {}
