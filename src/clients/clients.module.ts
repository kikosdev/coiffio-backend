import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Client, ClientSchema } from './schemas/client.schema';
import { Appointment, AppointmentSchema } from '../booking/schemas/appointment.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { IdentityModule } from '../identity/identity.module';
import { ClientsService } from './clients.service';
import { ClientsController } from './clients.controller';
import { ClientMeController } from './client-me.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Client.name, schema: ClientSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      // getLatestVisit() résout le slug du salon du dernier RDV (voir clients.service.ts).
      { name: Salon.name, schema: SalonSchema },
      // Enrichissement en lecture de Client.email vide (findAll/findOne) — GLOBAL, cf. clients.service.ts.
      { name: User.name, schema: UserSchema },
    ]),
    IdentityModule,
  ],
  controllers: [ClientsController, ClientMeController],
  providers: [ClientsService],
  exports: [ClientsService, MongooseModule],
})
export class ClientsModule {}
