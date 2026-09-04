import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SalaryAdvance, SalaryAdvanceSchema } from './schemas/salary-advance.schema';
import { SalaryPayment, SalaryPaymentSchema } from './schemas/salary-payment.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { StaffProfile, StaffProfileSchema } from '../team/schemas/staff-profile.schema';
import { Payment, PaymentSchema } from '../finance/schemas/payment.schema';
import { CashSession, CashSessionSchema } from '../finance/schemas/cash-session.schema';
import { CashMovement, CashMovementSchema } from '../finance/schemas/cash-movement.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdvancesService } from './advances.service';
import { AdvancesController } from './advances.controller';
import { PayrollService } from './payroll.service';
import { PayrollController } from './payroll.controller';

@Module({
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([
      { name: SalaryAdvance.name, schema: SalaryAdvanceSchema },
      { name: SalaryPayment.name, schema: SalaryPaymentSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: StaffProfile.name, schema: StaffProfileSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: CashSession.name, schema: CashSessionSchema },
      { name: CashMovement.name, schema: CashMovementSchema },
    ]),
  ],
  controllers: [AdvancesController, PayrollController],
  providers: [AdvancesService, PayrollService],
  exports: [AdvancesService, PayrollService, MongooseModule],
})
export class PayrollModule {}
