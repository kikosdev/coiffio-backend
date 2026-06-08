import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports:     [OrdersModule],
  controllers: [MeController],
})
export class MeModule {}
