import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';
import { Service, ServiceSchema } from '../schemas/service.schema';
import { Appointment, AppointmentSchema } from '../schemas/appointment.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Service.name,     schema: ServiceSchema },
      { name: Appointment.name, schema: AppointmentSchema },
    ]),
  ],
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
