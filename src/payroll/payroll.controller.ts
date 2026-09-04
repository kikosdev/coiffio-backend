import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PayrollService } from './payroll.service';
import { CreatePayrollDto, ListPayrollQueryDto, PayrollPreviewQueryDto } from './dto/payroll.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Paie mensuelle (SKILL_owner_paie_rh, P1-P15). Écriture (preview + payout) = owner
 * uniquement (P11) — un staff lit strictement ses propres fiches via `/payroll/me` (#9).
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll')
@UseGuards(JwtGuard, RolesGuard)
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @ApiOperation({ summary: 'Preview a staff member payroll for a period (nothing persisted)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('preview')
  @Roles('owner')
  async preview(@Query() query: PayrollPreviewQueryDto) {
    const data = await this.payroll.preview(query);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Pay a staff member for a period (transactional payout, P7)' })
  @ApiResponse({ status: 201, description: 'Payroll paid.' })
  @Post()
  @Roles('owner')
  async pay(@CurrentUser() user: AuthUser, @Body() dto: CreatePayrollDto) {
    const data = await this.payroll.pay(user, dto);
    return { data, message: 'Payroll paid.' };
  }

  @ApiOperation({ summary: 'List payslips — year+month for a salon-wide period overview, or staffId alone for one staff\'s full history' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  @Roles('owner')
  async list(@Query() query: ListPayrollQueryDto) {
    const data = await this.payroll.listForOwner(query);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'List my own payslips, all periods (#9)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('me')
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async listMine(@CurrentUser() user: AuthUser) {
    const data = await this.payroll.listForStaff(user);
    return { data, message: 'OK' };
  }
}
