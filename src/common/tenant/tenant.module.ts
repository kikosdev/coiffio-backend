import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Staff, StaffSchema } from '../../team/schemas/staff.schema';
import { LocationsModule } from '../../locations/locations.module';
import { TenantContextMiddleware } from './tenant-context.middleware';

@Module({
  imports: [MongooseModule.forFeature([{ name: Staff.name, schema: StaffSchema }]), LocationsModule],
  providers: [TenantContextMiddleware],
  exports: [TenantContextMiddleware],
})
export class TenantModule {}
