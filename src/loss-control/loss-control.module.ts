import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DoseLog, DoseLogSchema } from './schemas/dose-log.schema';
import { LossAlert, LossAlertSchema } from './schemas/loss-alert.schema';
import { Appointment, AppointmentSchema } from '../booking/schemas/appointment.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { Product, ProductSchema } from '../stock/schemas/product.schema';
import { StockMove, StockMoveSchema } from '../stock/schemas/stock-move.schema';
import { Sale, SaleSchema } from '../finance/schemas/sale.schema';
import { Payment, PaymentSchema } from '../finance/schemas/payment.schema';
import { Client, ClientSchema } from '../clients/schemas/client.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import { DoseLogService } from './dose-log.service';
import { LossControlAnalyticsService } from './loss-control-analytics.service';
import { LossAlertService } from './loss-alert.service';
import { PosDoseLogController } from './pos-dose-log.controller';
import { DoseLogController } from './dose-log.controller';
import { LossControlAnalyticsController } from './loss-control-analytics.controller';
import { LossAlertController } from './loss-alert.controller';

@Module({
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([
      { name: DoseLog.name, schema: DoseLogSchema },
      { name: LossAlert.name, schema: LossAlertSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: Salon.name, schema: SalonSchema },
      { name: Product.name, schema: ProductSchema },
      { name: StockMove.name, schema: StockMoveSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Client.name, schema: ClientSchema },
      { name: Staff.name, schema: StaffSchema },
    ]),
  ],
  controllers: [PosDoseLogController, DoseLogController, LossControlAnalyticsController, LossAlertController],
  providers: [DoseLogService, LossControlAnalyticsService, LossAlertService],
  exports: [DoseLogService, LossControlAnalyticsService, LossAlertService, MongooseModule],
})
export class LossControlModule {}
