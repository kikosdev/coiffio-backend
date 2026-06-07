import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';
import { TeamMember, TeamMemberSchema } from '../schemas/team-member.schema';
import { LeaveRequest, LeaveRequestSchema } from '../schemas/leave-request.schema';
import { PayPeriod, PayPeriodSchema } from '../schemas/pay-period.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TeamMember.name, schema: TeamMemberSchema },
      { name: LeaveRequest.name, schema: LeaveRequestSchema },
      { name: PayPeriod.name, schema: PayPeriodSchema },
    ]),
  ],
  controllers: [TeamController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
