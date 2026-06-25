import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { StockService } from './stock.service';
import { CreateProductDto, UpdateProductDto, RestockDto, AdjustStockDto, ListProductsQueryDto } from './dto/stock.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/** Stock & produits (Sprint 6). GET /products public (storefront Sprint 7) ; mutations owner·manager. */
@Controller()
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get('products')
  @UseGuards(OptionalJwtGuard)
  async list(@Req() req: Request, @Query() query: ListProductsQueryDto) {
    const data = await this.stock.list(getSalonScope(req), {
      category: query.category,
      activeOnly: query.activeOnly !== 'false',
      search: query.search,
      inStock: query.inStock === 'true',
    });
    return { data, message: 'OK' };
  }

  @Post('products')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async create(@Req() req: Request, @Body() dto: CreateProductDto) {
    const data = await this.stock.create(getSalonScope(req), dto);
    return { data, message: 'Product created.' };
  }

  @Patch('products/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    const data = await this.stock.update(getSalonScope(req), id, dto);
    return { data, message: 'Product updated.' };
  }

  @Delete('products/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async remove(@Req() req: Request, @Param('id') id: string) {
    const data = await this.stock.softDelete(getSalonScope(req), id);
    return { data, message: 'Product archived.' };
  }

  @Post('products/:id/restock')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async restock(@Req() req: Request, @CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RestockDto) {
    const data = await this.stock.restock(getSalonScope(req), user, id, dto.qty, dto.note);
    return { data, message: 'Restocked.' };
  }

  @Post('products/:id/adjust')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async adjust(@Req() req: Request, @CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AdjustStockDto) {
    const data = await this.stock.adjustStock(getSalonScope(req), user, id, dto);
    return { data, message: 'Stock adjusted.' };
  }

  @Get('stock/movements')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async movements(@Req() req: Request, @Query('productId') productId?: string) {
    const data = await this.stock.movements(getSalonScope(req), productId);
    return { data, message: 'OK' };
  }

  @Get('stock/low')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async low(@Req() req: Request) {
    const data = await this.stock.low(getSalonScope(req));
    return { data, message: 'OK' };
  }
}
