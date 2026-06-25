import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Payment, PaymentSchema } from './schemas/payment.schema';
import { Expense, ExpenseSchema } from './schemas/expense.schema';
import { Sale, SaleSchema } from './schemas/sale.schema';
import { StaffProfile, StaffProfileSchema } from '../team/schemas/staff-profile.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { Product, ProductSchema } from '../stock/schemas/product.schema';
import { StockMove, StockMoveSchema } from '../stock/schemas/stock-move.schema';
import { Appointment, AppointmentSchema } from '../booking/schemas/appointment.schema';
import { FinanceService } from './finance.service';
import { FinanceController } from './finance.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: Expense.name, schema: ExpenseSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: StaffProfile.name, schema: StaffProfileSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: Product.name, schema: ProductSchema },
      { name: StockMove.name, schema: StockMoveSchema },
      { name: Appointment.name, schema: AppointmentSchema },
    ]),
  ],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService, MongooseModule],
})
export class FinanceModule {}
