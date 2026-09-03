import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import { SalonsController } from './salons.controller';
import { SalonsService } from './salons.service';
import { SalonCatalogService } from './salon-catalog.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Salon.name, schema: SalonSchema },
      { name: Service.name, schema: ServiceSchema },
    ]),
  ],
  controllers: [SalonsController],
  providers: [SalonsService, SalonCatalogService],
  exports: [SalonCatalogService],
})
export class SalonsModule {}
