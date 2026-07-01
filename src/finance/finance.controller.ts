import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FinanceService, Period } from './finance.service';
import { CreatePaymentDto, CreateExpenseDto, UpdateExpenseDto, ReportsQueryDto } from './dto/finance.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Finance / La Caisse (Sprint 5). Encaissement (owner·manager·stylist), vue split #9,
 * refund owner-only #8, dépenses + rapports + export CSV (owner·manager). Enveloppe + scope.
 */
@ApiTags('Finance')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtGuard, RolesGuard)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @ApiOperation({ summary: 'Record a payment for an appointment' })
  @ApiResponse({ status: 201, description: 'Payment recorded.' })
  @Post('payments')
  @Roles('owner', 'manager', 'stylist')
  async pay(@Req() req: Request, @Body() dto: CreatePaymentDto) {
    const data = await this.finance.createPayment(getSalonScope(req), dto);
    return { data, message: 'Payment recorded.' };
  }

  @ApiOperation({ summary: "Get the current staff member's own cash register (caisse) summary" })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('caisse/me')
  @Roles('owner', 'manager', 'stylist')
  async myCaisse(@Req() req: Request, @CurrentUser() user: AuthUser) {
    const data = await this.finance.myCaisse(getSalonScope(req), user);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Get the salon-wide cash register (caisse) overview' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('caisse/overview')
  @Roles('owner', 'manager')
  async overview(@Req() req: Request) {
    const data = await this.finance.overview(getSalonScope(req));
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Refund a payment (owner only)' })
  @ApiResponse({ status: 201, description: 'Payment refunded.' })
  @Post('payments/:id/refund')
  @Roles('owner')
  async refund(@Req() req: Request, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    const data = await this.finance.refund(getSalonScope(req), user, id);
    return { data, message: 'Payment refunded.' };
  }

  @ApiOperation({ summary: 'List expenses for the salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('expenses')
  @Roles('owner', 'manager')
  async listExpenses(@Req() req: Request) {
    const data = await this.finance.listExpenses(getSalonScope(req));
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Record a new expense' })
  @ApiResponse({ status: 201, description: 'Expense recorded.' })
  @Post('expenses')
  @Roles('owner', 'manager')
  async createExpense(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() dto: CreateExpenseDto) {
    const data = await this.finance.createExpense(getSalonScope(req), user, dto);
    return { data, message: 'Expense recorded.' };
  }

  @ApiOperation({ summary: 'Update an existing expense' })
  @ApiResponse({ status: 200, description: 'Expense updated.' })
  @Patch('expenses/:id')
  @Roles('owner', 'manager')
  async updateExpense(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateExpenseDto) {
    const data = await this.finance.updateExpense(getSalonScope(req), id, dto);
    return { data, message: 'Expense updated.' };
  }

  @ApiOperation({ summary: 'Delete an expense' })
  @ApiResponse({ status: 200, description: 'Expense deleted.' })
  @Delete('expenses/:id')
  @Roles('owner', 'manager')
  async deleteExpense(@Req() req: Request, @Param('id') id: string) {
    const data = await this.finance.deleteExpense(getSalonScope(req), id);
    return { data, message: 'Expense deleted.' };
  }

  @ApiOperation({ summary: 'Get a financial report for a given period' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('reports')
  @Roles('owner', 'manager')
  async report(@Req() req: Request, @Query() query: ReportsQueryDto) {
    const data = await this.finance.report(getSalonScope(req), query.period ?? 'day');
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Export a financial report for a given period as CSV' })
  @ApiResponse({ status: 200, description: 'CSV file download.' })
  @Get('reports/export.csv')
  @Roles('owner', 'manager')
  async exportCsv(@Req() req: Request, @Query() query: ReportsQueryDto, @Res() res: Response) {
    const period: Period = query.period ?? 'day';
    const csv = await this.finance.exportCsv(getSalonScope(req), period);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="report-${period}.csv"`);
    res.send(csv);
  }
}
