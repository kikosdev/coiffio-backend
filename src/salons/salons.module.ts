import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { SalonsController } from './salons.controller';
import { SalonsService } from './salons.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Salon.name, schema: SalonSchema }])],
  controllers: [SalonsController],
  providers: [SalonsService],
})
export class SalonsModule {}
