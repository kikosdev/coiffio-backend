import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { StockService } from './stock.service';
import {
  CreateProductDto,
  UpdateProductDto,
  UpdateProductDosesDto,
  RestockDto,
  AdjustStockDto,
  ListProductsQueryDto,
  CreateStockMovementDto,
  CreateInventoryCountDto,
  ListStockMovementsQueryDto,
} from './dto/stock.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { GuestScopeService } from '../common/tenant/guest-scope.service';
import { Destructive } from '../common/decorators/destructive.decorator';
import { PosScopeGuard, PosUser } from '../common/guards/pos-scope.guard';
import { CurrentPosUser } from '../common/decorators/current-pos-user.decorator';
import { FeatureGuard } from '../common/entitlements/guards/feature.guard';
import { RequiresFeature } from '../common/entitlements/decorators/requires-feature.decorator';

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

  /**
   * F1-bis : liste BACKOFFICE, authentifiée — manquait entièrement (seule `list()` ci-dessus,
   * publique par `:salonSlug`, existait). `products` est LOCATION_SCOPED (scoping-registry.ts) :
   * contrairement à `ServicesController#list` (TENANT_SCOPED, `salonId` seul), le plugin
   * injecte ICI `salonId` + `locationId` (la location courante du token) automatiquement sur
   * `productModel.find(filter)` — aucune résolution de scope à faire à la main, même pattern
   * que toute autre lecture LOCATION_SCOPED (ex. `SalesController`). Réutilise `StockService.list()`
   * tel quel : c'est le même service method que la route publique, le filtrage tenant/location
   * vient uniquement du `TenantContext` ambiant (guest vs JWT), pas d'un paramètre explicite.
   */
  @ApiOperation({ summary: 'List products for the current salon (backoffice)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('products')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async listBackoffice(@Query() query: ListProductsQueryDto) {
    const data = await this.stock.list({
      category: query.category,
      activeOnly: query.activeOnly !== 'false',
      search: query.search,
      inStock: query.inStock === 'true',
      isConsumable: query.isConsumable !== undefined ? query.isConsumable === 'true' : undefined,
    });
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

  /** LC-1/LC-7 (SKILL_loss_control_doses.md) — owner-only, séparé de `update()` (owner+manager). */
  @ApiOperation({ summary: 'Configure a product for loss control (dosesPerUnit, isConsumable, varianceThresholdPct)' })
  @ApiResponse({ status: 200, description: 'Product doses updated.' })
  @ApiBearerAuth()
  @Patch('products/:id/doses')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner')
  async updateDoses(@Param('id') id: string, @Body() dto: UpdateProductDosesDto) {
    const data = await this.stock.updateDoses(id, dto);
    return { data, message: 'Product doses updated.' };
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

  /**
   * LC-5 (SKILL_loss_control_doses.md, Prompt 3) — comptoir : refill / ajustement / perte.
   * `PosScopeGuard`, jamais `JwtGuard`+`RolesGuard` (poste PIN, sans role).
   */
  @ApiOperation({ summary: 'Declare a stock movement from the counter (refill, adjustment, loss)' })
  @ApiResponse({ status: 201, description: 'Movement recorded.' })
  @ApiBearerAuth()
  @Post('pos/stock-movements')
  @UseGuards(PosScopeGuard, FeatureGuard)
  @RequiresFeature('pos')
  async declareMovement(@CurrentPosUser() caller: PosUser, @Body() dto: CreateStockMovementDto) {
    const data = await this.stock.declareMovement(dto, caller.staffId);
    return { data, message: 'Movement recorded.' };
  }

  /**
   * LC-5 — INVENTAIRE PHYSIQUE. LE point de vérité du loss control (Calc 2, Prompt 4) : sans
   * cette saisie, l'écart de stock compare du théorique à du théorique. Cadence libre, aucune
   * contrainte système — `Product.lastInventoryAt` sert de base à un futur rappel.
   */
  @ApiOperation({ summary: 'Record a physical inventory count (absolute value, not a delta)' })
  @ApiResponse({ status: 201, description: 'Inventory recorded.' })
  @ApiBearerAuth()
  @Post('pos/stock-movements/count')
  @UseGuards(PosScopeGuard, FeatureGuard)
  @RequiresFeature('pos')
  async declareInventoryCount(@CurrentPosUser() caller: PosUser, @Body() dto: CreateInventoryCountDto) {
    const data = await this.stock.declareInventoryCount(dto, caller.staffId);
    return { data, message: 'Inventory recorded.' };
  }

  @ApiOperation({ summary: 'Get the counter stock movement journal, filterable by period and product' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('pos/stock-movements')
  @UseGuards(PosScopeGuard, FeatureGuard)
  @RequiresFeature('pos')
  async listPosMovements(@Query() query: ListStockMovementsQueryDto) {
    const data = await this.stock.movements(query.productId, query.period);
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
