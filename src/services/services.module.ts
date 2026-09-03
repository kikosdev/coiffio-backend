import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Service, ServiceSchema } from './schemas/service.schema';
import { Product, ProductSchema } from '../stock/schemas/product.schema';
import { ServicesService } from './services.service';
import { ServicesController } from './services.controller';
import { SalonsModule } from '../salons/salons.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Service.name, schema: ServiceSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    SalonsModule,
  ],
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService, MongooseModule],
})
export class ServicesModule {}
