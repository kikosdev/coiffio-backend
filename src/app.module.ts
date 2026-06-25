import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { ClientsModule } from './clients/clients.module';
import { ServicesModule } from './services/services.module';
import { TeamModule } from './team/team.module';
import { BookingModule } from './booking/booking.module';
import { FinanceModule } from './finance/finance.module';
import { StockModule } from './stock/stock.module';
import { OrdersModule } from './orders/orders.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OverviewModule } from './overview/overview.module';
import { SettingsModule } from './settings/settings.module';
import { PublicModule } from './public/public.module';
import { SalesModule } from './sales/sales.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    CommonModule,
    MongooseModule.forRootAsync({ useFactory: () => ({ uri: process.env.MONGO_URI }) }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    AuthModule,
    ClientsModule,
    ServicesModule,
    TeamModule,
    BookingModule,
    FinanceModule,
    StockModule,
    OrdersModule,
    NotificationsModule,
    OverviewModule,
    SettingsModule,
    PublicModule,
    SalesModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
