import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Client, ClientSchema } from './schemas/client.schema';
import { Appointment, AppointmentSchema } from '../booking/schemas/appointment.schema';
import { ClientsService } from './clients.service';
import { ClientsController } from './clients.controller';
import { ClientMeController } from './client-me.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Client.name, schema: ClientSchema },
      { name: Appointment.name, schema: AppointmentSchema },
    ]),
  ],
  controllers: [ClientsController, ClientMeController],
  providers: [ClientsService],
  exports: [ClientsService, MongooseModule],
})
export class ClientsModule {}
