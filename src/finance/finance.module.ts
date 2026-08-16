import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Payment, PaymentSchema } from './schemas/payment.schema';
import { Expense, ExpenseSchema } from './schemas/expense.schema';
import { Sale, SaleSchema } from './schemas/sale.schema';
import { CashSession, CashSessionSchema } from './schemas/cash-session.schema';
import { CashMovement, CashMovementSchema } from './schemas/cash-movement.schema';
import { StaffProfile, StaffProfileSchema } from '../team/schemas/staff-profile.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { Product, ProductSchema } from '../stock/schemas/product.schema';
import { StockMove, StockMoveSchema } from '../stock/schemas/stock-move.schema';
import { Appointment, AppointmentSchema } from '../booking/schemas/appointment.schema';
import { DoseLog, DoseLogSchema } from '../loss-control/schemas/dose-log.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { FinanceService } from './finance.service';
import { FinanceController } from './finance.controller';
import { CaisseService } from './caisse.service';
import { CaisseController } from './caisse.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { BookingModule } from '../booking/booking.module';
import { LossControlModule } from '../loss-control/loss-control.module';

@Module({
  imports: [
    NotificationsModule,
    BookingModule,
    LossControlModule,
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: Expense.name, schema: ExpenseSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: CashSession.name, schema: CashSessionSchema },
      { name: CashMovement.name, schema: CashMovementSchema },
      { name: StaffProfile.name, schema: StaffProfileSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: Product.name, schema: ProductSchema },
      { name: StockMove.name, schema: StockMoveSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: DoseLog.name, schema: DoseLogSchema },
      { name: Salon.name, schema: SalonSchema },
    ]),
  ],
  controllers: [FinanceController, CaisseController],
  providers: [FinanceService, CaisseService],
  exports: [FinanceService, CaisseService, MongooseModule],
})
export class FinanceModule {}
