import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SalesService } from './sales.service';
import { BestSellersQueryDto, CreateSaleDto, SalesQueryDto } from './dto/create-sale.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/** Ventes retail POS (Sprint 6). Comptoir sans RDV, décrément stock, best-sellers. */
@Controller()
@UseGuards(JwtGuard, RolesGuard)
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post('sales')
  @Roles('owner', 'manager', 'stylist')
  async create(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() dto: CreateSaleDto) {
    const data = await this.sales.create(getSalonScope(req), dto, user);
    return { data, message: 'Vente enregistrée.' };
  }

  // /sales/me and /sales/best-sellers MUST come before /sales/:id
  @Get('sales/me')
  @Roles('owner', 'manager', 'stylist')
  async findMine(@Req() req: Request, @CurrentUser() user: AuthUser, @Query() q: SalesQueryDto) {
    const data = await this.sales.findMine(user, getSalonScope(req), q);
    return { data, message: 'OK' };
  }

  @Get('sales/best-sellers')
  @Roles('owner', 'manager')
  async bestSellers(@Req() req: Request, @Query() q: BestSellersQueryDto) {
    const data = await this.sales.bestSellers(getSalonScope(req), q);
    return { data, message: 'OK' };
  }

  @Get('sales')
  @Roles('owner', 'manager')
  async findAll(@Req() req: Request, @Query() q: SalesQueryDto) {
    const data = await this.sales.findAll(getSalonScope(req), q);
    return { data, message: 'OK' };
  }

  @Get('sales/:id')
  @Roles('owner', 'manager', 'stylist')
  async findOne(@Req() req: Request, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    const data = await this.sales.findOne(id, user, getSalonScope(req));
    return { data, message: 'OK' };
  }

  @Delete('sales/:id')
  @Roles('owner')
  async voidSale(
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('restock') restock?: string,
  ) {
    const data = await this.sales.voidSale(id, restock === 'true', user, getSalonScope(req));
    return { data, message: 'Vente annulée.' };
  }
}
