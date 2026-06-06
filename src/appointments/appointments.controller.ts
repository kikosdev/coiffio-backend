import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AppointmentsService } from './appointments.service';
import { AppointmentStatus } from '../schemas/appointment.schema';

@Controller('appointments')
export class AppointmentsController {
  constructor(private appointmentsService: AppointmentsService) {}

  @UseGuards(AuthGuard('jwt'))
  @Get()
  findAll(
    @Query('stylistId') stylistId?: string,
    @Query('status') status?: string,
    @Query('date') date?: string,
  ) {
    return this.appointmentsService.findAll(stylistId, status, date);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('mine')
  findMine(@Request() req: any) {
    return this.appointmentsService.findMine(req.user.sub);
  }

  @Post()
  create(@Body() body: any) {
    return this.appointmentsService.create(body);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body('status') status: AppointmentStatus) {
    return this.appointmentsService.updateStatus(id, status);
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete(':id')
  cancel(@Param('id') id: string) {
    return this.appointmentsService.cancel(id);
  }
}
