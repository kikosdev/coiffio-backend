import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClientProfile, ClientProfileSchema } from './schemas/client-profile.schema';
import { Client, ClientSchema } from '../clients/schemas/client.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { Appointment, AppointmentSchema } from '../booking/schemas/appointment.schema';
import { LocationsModule } from '../locations/locations.module';
import { ClientProfileService } from './client-profile.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ClientProfile.name, schema: ClientProfileSchema },
      { name: Client.name, schema: ClientSchema },
      { name: Salon.name, schema: SalonSchema },
      { name: Appointment.name, schema: AppointmentSchema },
    ]),
    LocationsModule,
  ],
  providers: [ClientProfileService],
  exports: [ClientProfileService, MongooseModule],
})
export class IdentityModule {}
