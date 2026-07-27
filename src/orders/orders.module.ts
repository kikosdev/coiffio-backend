import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Cart, CartSchema } from './schemas/cart.schema';
import { Order, OrderSchema } from './schemas/order.schema';
import { Product, ProductSchema } from '../stock/schemas/product.schema';
import { StockMove, StockMoveSchema } from '../stock/schemas/stock-move.schema';
import { Sale, SaleSchema } from '../finance/schemas/sale.schema';
import { Client, ClientSchema } from '../clients/schemas/client.schema';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { IdentityModule } from '../identity/identity.module';

@Module({
  imports: [
    NotificationsModule,
    IdentityModule,
    MongooseModule.forFeature([
      { name: Cart.name, schema: CartSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Product.name, schema: ProductSchema },
      { name: StockMove.name, schema: StockMoveSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: Client.name, schema: ClientSchema },
    ]),
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService, MongooseModule],
})
export class OrdersModule {}
