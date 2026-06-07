import { Controller, Get, Post, Patch, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TeamService } from './team.service';
import { TeamMember } from '../schemas/team-member.schema';
import { LeaveRequest, LeaveDecision } from '../schemas/leave-request.schema';

type WeekDay = number[] | 'leave' | null;

@Controller('team')
export class TeamController {
  constructor(private teamService: TeamService) {}

  // ── Members ──
  @Get()
  findAll() {
    return this.teamService.findAll();
  }

  @Get('leave-requests')
  listLeaves() {
    return this.teamService.listLeaveRequests();
  }

  @Get('periods')
  listPeriods() {
    return this.teamService.listPeriods();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.teamService.findOne(id);
  }

  @Get(':id/payslip')
  payslip(@Param('id') id: string, @Query('period') period: string) {
    return this.teamService.payslip(id, period);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post()
  create(@Body() body: Partial<TeamMember>) {
    return this.teamService.create(body);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Partial<TeamMember>) {
    return this.teamService.update(id, body);
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.teamService.remove(id);
  }

  // ── Temps de travail (rota) ──
  @UseGuards(AuthGuard('jwt'))
  @Put(':id/week')
  setWeek(@Param('id') id: string, @Body('week') week: WeekDay[]) {
    return this.teamService.setWeek(id, week);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch(':id/week/:day')
  setDay(@Param('id') id: string, @Param('day') day: string, @Body('value') value: WeekDay) {
    return this.teamService.setDay(id, parseInt(day, 10), value);
  }

  // ── Congés ──
  @UseGuards(AuthGuard('jwt'))
  @Post('leave-requests')
  createLeave(@Body() body: Partial<LeaveRequest>) {
    return this.teamService.createLeaveRequest(body);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch('leave-requests/:id/decision')
  decideLeave(@Param('id') id: string, @Body('decided') decided: LeaveDecision) {
    return this.teamService.decideLeave(id, decided);
  }
}
