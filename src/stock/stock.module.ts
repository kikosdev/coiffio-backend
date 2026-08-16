import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import { StockMove, StockMoveSchema } from './schemas/stock-move.schema';
import { StockService } from './stock.service';
import { StockController } from './stock.controller';
import { TenantModule } from '../common/tenant/tenant.module';
import { LossControlModule } from '../loss-control/loss-control.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: StockMove.name, schema: StockMoveSchema },
    ]),
    TenantModule,
    LossControlModule,
  ],
  controllers: [StockController],
  providers: [StockService],
  exports: [StockService, MongooseModule],
})
export class StockModule {}
