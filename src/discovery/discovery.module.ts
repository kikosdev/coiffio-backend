import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { Location, LocationSchema } from '../locations/schemas/location.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import { Testimonial, TestimonialSchema } from '../public/schemas/testimonial.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { BookingModule } from '../booking/booking.module';
import { DiscoveryService } from './discovery.service';
import { DiscoveryController } from './discovery.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Salon.name, schema: SalonSchema },
      { name: Location.name, schema: LocationSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: Testimonial.name, schema: TestimonialSchema },
      { name: Staff.name, schema: StaffSchema },
    ]),
    BookingModule,
  ],
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
})
export class DiscoveryModule {}
