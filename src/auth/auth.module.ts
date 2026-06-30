import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule } from '@nestjs/config';
import { User, UserSchema } from './schemas/user.schema';
import { Staff, StaffSchema } from '../team/schemas/staff.schema';
import { Schedule, ScheduleSchema } from '../team/schemas/schedule.schema';
import { StaffProfile, StaffProfileSchema } from '../team/schemas/staff-profile.schema';
import { Client, ClientSchema } from '../clients/schemas/client.schema';
import { Salon, SalonSchema } from '../seed/schemas/salon.schema';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PassportModule,
    MongooseModule.forFeature([
      { name: User.name,         schema: UserSchema },
      { name: Staff.name,        schema: StaffSchema },
      { name: Schedule.name,     schema: ScheduleSchema },
      { name: StaffProfile.name, schema: StaffProfileSchema },
      { name: Client.name,       schema: ClientSchema },
      { name: Salon.name,        schema: SalonSchema },
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, MongooseModule],
})
export class AuthModule {}
