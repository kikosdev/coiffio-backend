import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Sale, SaleSchema } from '../finance/schemas/sale.schema';
import { Product, ProductSchema } from '../stock/schemas/product.schema';
import { StockMove, StockMoveSchema } from '../stock/schemas/stock-move.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import { SalesService } from './sales.service';
import { SalesController } from './sales.controller';

@Module({
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      { name: Product.name, schema: ProductSchema },
      { name: StockMove.name, schema: StockMoveSchema },
    ]),
  ],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
