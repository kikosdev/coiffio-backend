import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { SalonRole, SalonRoleSchema } from './schemas/salon-role.schema';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Salon.name, schema: SalonSchema },
      { name: SalonRole.name, schema: SalonRoleSchema },
    ]),
  ],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
