import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { StaffProfile, StaffProfileSchema } from '../team/schemas/staff-profile.schema';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Service.name, schema: ServiceSchema },
      { name: Salon.name, schema: SalonSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: StaffProfile.name, schema: StaffProfileSchema },
    ]),
  ],
  controllers: [MarketplaceController],
  providers: [MarketplaceService],
})
export class MarketplaceModule {}
