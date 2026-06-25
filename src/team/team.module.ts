import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Staff, StaffSchema } from './schemas/staff.schema';
import { Schedule, ScheduleSchema } from './schemas/schedule.schema';
import { StaffProfile, StaffProfileSchema } from './schemas/staff-profile.schema';
import { LeaveRequest, LeaveRequestSchema } from './schemas/leave-request.schema';
import { Appointment, AppointmentSchema } from '../booking/schemas/appointment.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { TeamService } from './team.service';
import { ScheduleService } from './schedule.service';
import { LeaveService } from './leave.service';
import { TeamController } from './team.controller';
import { ScheduleController } from './schedule.controller';
import { LeaveController } from './leave.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([
      { name: Staff.name, schema: StaffSchema },
      { name: Schedule.name, schema: ScheduleSchema },
      { name: StaffProfile.name, schema: StaffProfileSchema },
      { name: LeaveRequest.name, schema: LeaveRequestSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Salon.name, schema: SalonSchema },
    ]),
  ],
  controllers: [TeamController, ScheduleController, LeaveController],
  providers: [TeamService, ScheduleService, LeaveService],
  exports: [TeamService, ScheduleService, LeaveService, MongooseModule],
})
export class TeamModule {}
