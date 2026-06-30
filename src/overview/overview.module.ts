import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Appointment, AppointmentSchema } from '../booking/schemas/appointment.schema';
import { Schedule, ScheduleSchema } from '../team/schemas/schedule.schema';
import { Sale, SaleSchema } from '../finance/schemas/sale.schema';
import { Payment, PaymentSchema } from '../finance/schemas/payment.schema';
import { Product, ProductSchema } from '../stock/schemas/product.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { LeaveRequest, LeaveRequestSchema } from '../team/schemas/leave-request.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { Client, ClientSchema } from '../clients/schemas/client.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import { OverviewService } from './overview.service';
import { OverviewController } from './overview.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Schedule.name, schema: ScheduleSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Order.name, schema: OrderSchema },
      { name: LeaveRequest.name, schema: LeaveRequestSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: Client.name, schema: ClientSchema },
      { name: Service.name, schema: ServiceSchema },
    ]),
  ],
  controllers: [OverviewController],
  providers: [OverviewService],
  exports: [OverviewService],
})
export class OverviewModule {}
