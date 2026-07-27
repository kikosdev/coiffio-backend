import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Location, LocationSchema } from './schemas/location.schema';
import { LocationService } from './location.service';
import { LocationController } from './location.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: Location.name, schema: LocationSchema }])],
  controllers: [LocationController],
  providers: [LocationService],
  exports: [LocationService, MongooseModule],
})
export class LocationsModule {}
