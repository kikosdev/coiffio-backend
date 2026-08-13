import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';
import { Testimonial, TestimonialSchema } from './schemas/testimonial.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { StaffProfile, StaffProfileSchema } from '../team/schemas/staff-profile.schema';
import { Client, ClientSchema } from '../clients/schemas/client.schema';
import { TenantModule } from '../common/tenant/tenant.module';

@Module({
  imports: [
    // GuestScopeService — pose le TenantContext manquant sur `:salonSlug/team` (voir controller).
    TenantModule,
    MongooseModule.forFeature([
      { name: Testimonial.name, schema: TestimonialSchema },
      { name: Salon.name, schema: SalonSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: StaffProfile.name, schema: StaffProfileSchema },
      { name: Client.name, schema: ClientSchema },
    ]),
  ],
  controllers: [PublicController],
  providers: [PublicService],
  exports: [PublicService],
})
export class PublicModule {}
