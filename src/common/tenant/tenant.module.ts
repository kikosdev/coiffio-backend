import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Staff, StaffSchema } from '../../team/schemas/staff.schema';
import { Salon, SalonSchema } from '../../seed/schemas/salon.schema';
import { LocationsModule } from '../../locations/locations.module';
import { IdentityModule } from '../../identity/identity.module';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { GuestScopeService } from './guest-scope.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Staff.name, schema: StaffSchema },
      { name: Salon.name, schema: SalonSchema },
    ]),
    LocationsModule,
    IdentityModule,
  ],
  providers: [TenantContextMiddleware, GuestScopeService],
  exports: [TenantContextMiddleware, GuestScopeService],
})
export class TenantModule {}
