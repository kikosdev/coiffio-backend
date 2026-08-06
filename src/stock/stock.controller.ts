import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { StockService } from './stock.service';
import { CreateProductDto, UpdateProductDto, RestockDto, AdjustStockDto, ListProductsQueryDto } from './dto/stock.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { GuestScopeService } from '../common/tenant/guest-scope.service';
import { Destructive } from '../common/decorators/destructive.decorator';

/**
 * Stock & produits (Sprint 6). GET /:salonSlug/products public (storefront Sprint 7) ;
 * mutations owner·manager. Prompt 6, Partie C (bug trouvé en testant) : `list()` résout
 * maintenant le tenant par `:salonSlug` + pose un TenantContext via
 * `GuestScopeService`/`runAsGuest` — `getSalonScope(req)` ne posait jamais de contexte
 * AsyncLocalStorage, 500 systématique sur toute requête sans JWT (voir booking.controller.ts
 * pour le détail). Le reste reste sur `currentScope()`.
 */
@ApiTags('Stock')
@Controller()
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly guestScope: GuestScopeService,
  ) {}

  @ApiOperation({ summary: 'List products (public storefront, optionally authenticated)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/products')
  @UseGuards(OptionalJwtGuard)
  async list(@Param('salonSlug') salonSlug: string, @Query() query: ListProductsQueryDto) {
    const data = await this.guestScope.run(salonSlug, undefined, () =>
      this.stock.list({
        category: query.category,
        activeOnly: query.activeOnly !== 'false',
        search: query.search,
        inStock: query.inStock === 'true',
      }),
    );
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Create a new product' })
  @ApiResponse({ status: 201, description: 'Product created.' })
  @ApiBearerAuth()
  @Post('products')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async create(@Body() dto: CreateProductDto) {
    const data = await this.stock.create(dto);
    return { data, message: 'Product created.' };
  }

  @ApiOperation({ summary: 'Update a product' })
  @ApiResponse({ status: 200, description: 'Product updated.' })
  @ApiBearerAuth()
  @Patch('products/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    const data = await this.stock.update(id, dto);
    return { data, message: 'Product updated.' };
  }

  @ApiOperation({ summary: 'Archive (soft-delete) a product' })
  @ApiResponse({ status: 200, description: 'Product archived.' })
  @ApiBearerAuth()
  @Delete('products/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  @Destructive()
  async remove(@Param('id') id: string) {
    const data = await this.stock.softDelete(id);
    return { data, message: 'Product archived.' };
  }

  @ApiOperation({ summary: 'Restock a product by adding quantity' })
  @ApiResponse({ status: 201, description: 'Restocked.' })
  @ApiBearerAuth()
  @Post('products/:id/restock')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async restock(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RestockDto) {
    const data = await this.stock.restock(user, id, dto.qty, dto.note);
    return { data, message: 'Restocked.' };
  }

  @ApiOperation({ summary: 'Manually adjust a product stock quantity' })
  @ApiResponse({ status: 201, description: 'Stock adjusted.' })
  @ApiBearerAuth()
  @Post('products/:id/adjust')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async adjust(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AdjustStockDto) {
    const data = await this.stock.adjustStock(user, id, dto);
    return { data, message: 'Stock adjusted.' };
  }

  @ApiOperation({ summary: 'List stock movements, optionally filtered by product' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('stock/movements')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async movements(@Query('productId') productId?: string) {
    const data = await this.stock.movements(productId);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'List products with low stock' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('stock/low')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async low() {
    const data = await this.stock.low();
    return { data, message: 'OK' };
  }
}
