import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StylistsController } from './stylists.controller';
import { StylistsService } from './stylists.service';
import { Stylist, StylistSchema } from '../schemas/stylist.schema';
import { Appointment, AppointmentSchema } from '../schemas/appointment.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Stylist.name, schema: StylistSchema },
      { name: Appointment.name, schema: AppointmentSchema },
    ]),
  ],
  controllers: [StylistsController],
  providers: [StylistsService],
  exports: [StylistsService],
})
export class StylistsModule {}
