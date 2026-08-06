import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { OrdersService, CartCtx } from './orders.service';
import { AddCartItemDto, CheckoutDto, UpdateCartItemDto, UpdateOrderStatusDto } from './dto/orders.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { GuestScopeService } from '../common/tenant/guest-scope.service';
import { FeatureGuard } from '../common/entitlements/guards/feature.guard';
import { RequiresFeature } from '../common/entitlements/decorators/requires-feature.decorator';
import { Destructive } from '../common/decorators/destructive.decorator';

const CART_COOKIE = 'cartToken';
const CART_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/**
 * Storefront & commandes (Sprint 7). Panier invité cookie httpOnly, checkout pickup-only #5.
 * Prompt 6, Partie C (bug trouvé en testant) : les routes storefront (shop/cart/checkout/
 * track) résolvent maintenant le tenant par `:salonSlug` + posent un TenantContext via
 * `GuestScopeService`/`runAsGuest` — `getSalonScope(req)` ne posait jamais de contexte
 * AsyncLocalStorage, 500 systématique sur toute requête sans JWT (voir booking.controller.ts
 * pour le détail). `merge`/`list`/`status` (JwtGuard-only) restent sur `currentScope()`.
 */
@ApiTags('Orders')
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly guestScope: GuestScopeService,
  ) {}

  private ctx(req: Request, user?: AuthUser): CartCtx {
    const cartToken = (req as Request & { cookies?: Record<string, string> }).cookies?.[CART_COOKIE];
    return { clientId: user?.role === 'client' ? user.sub : undefined, cartToken };
  }

  private setCartCookie(res: Response, token: string): void {
    res.cookie(CART_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: false, maxAge: CART_MAX_AGE });
  }

  // ─── Public storefront ─────────────────────────────────────────────────────

  @ApiOperation({ summary: 'List shop products available for a salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/shop/products')
  async shop(@Param('salonSlug') salonSlug: string) {
    const data = await this.guestScope.run(salonSlug, undefined, () => this.orders.shopProducts(), 'ecommerce');
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Get the current cart (guest cookie or authenticated client)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/cart')
  @UseGuards(OptionalJwtGuard)
  async getCart(@Param('salonSlug') salonSlug: string, @Req() req: Request, @CurrentUser() user: AuthUser | undefined) {
    const { cart } = await this.guestScope.run(salonSlug, undefined, () => this.orders.getCart(this.ctx(req, user)), 'ecommerce');
    return { data: cart ?? { items: [] }, message: 'OK' };
  }

  @ApiOperation({ summary: 'Add an item to the cart' })
  @ApiResponse({ status: 201, description: 'Added to cart.' })
  @Post(':salonSlug/cart/items')
  @UseGuards(OptionalJwtGuard)
  async addItem(
    @Param('salonSlug') salonSlug: string,
    @Req() req: Request,
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: AddCartItemDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { cart, newToken } = await this.guestScope.run(
      salonSlug,
      undefined,
      () => this.orders.addItem(this.ctx(req, user), dto.productId, dto.qty),
      'ecommerce',
    );
    if (newToken) this.setCartCookie(res, newToken);
    return { data: cart, message: 'Added to cart.' };
  }

  @ApiOperation({ summary: 'Update the quantity of a cart item' })
  @ApiResponse({ status: 200, description: 'Updated.' })
  @Patch(':salonSlug/cart/items/:productId')
  @UseGuards(OptionalJwtGuard)
  async updateItemQty(
    @Param('salonSlug') salonSlug: string,
    @Req() req: Request,
    @CurrentUser() user: AuthUser | undefined,
    @Param('productId') productId: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    const data = await this.guestScope.run(
      salonSlug,
      undefined,
      () => this.orders.updateItemQty(this.ctx(req, user), productId, dto.qty),
      'ecommerce',
    );
    return { data, message: 'Updated.' };
  }

  @ApiOperation({ summary: 'Remove an item from the cart' })
  @ApiResponse({ status: 200, description: 'Removed.' })
  @Delete(':salonSlug/cart/items/:productId')
  @UseGuards(OptionalJwtGuard)
  async removeItem(
    @Param('salonSlug') salonSlug: string,
    @Req() req: Request,
    @CurrentUser() user: AuthUser | undefined,
    @Param('productId') productId: string,
  ) {
    const data = await this.guestScope.run(
      salonSlug,
      undefined,
      () => this.orders.removeItem(this.ctx(req, user), productId),
      'ecommerce',
    );
    return { data, message: 'Removed.' };
  }

  @ApiOperation({ summary: "Merge a guest cart into the authenticated client's cart" })
  @ApiResponse({ status: 201, description: 'Cart merged.' })
  @ApiBearerAuth()
  @Post('cart/merge')
  @UseGuards(JwtGuard, RolesGuard, FeatureGuard)
  @Roles('client')
  @RequiresFeature('ecommerce')
  async merge(@Req() req: Request, @CurrentUser() user: AuthUser) {
    const cartToken = (req as Request & { cookies?: Record<string, string> }).cookies?.[CART_COOKIE];
    const data = await this.orders.merge(user.sub, cartToken);
    return { data, message: 'Cart merged.' };
  }

  @ApiOperation({ summary: 'Checkout the cart and place an order (pickup-only)' })
  @ApiResponse({ status: 201, description: 'Order placed.' })
  @Post(':salonSlug/orders')
  @UseGuards(OptionalJwtGuard)
  async checkout(
    @Param('salonSlug') salonSlug: string,
    @Req() req: Request,
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: CheckoutDto,
  ) {
    const data = await this.guestScope.run(
      salonSlug,
      undefined,
      () => this.orders.checkout(this.ctx(req, user), dto),
      'ecommerce',
    );
    return { data, message: 'Order placed.' };
  }

  @ApiOperation({ summary: 'Track an order by its track token' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':salonSlug/track/order/:trackToken')
  async track(@Param('salonSlug') salonSlug: string, @Param('trackToken') trackToken: string) {
    const data = await this.guestScope.run(salonSlug, undefined, () => this.orders.track(trackToken), 'ecommerce');
    return { data, message: 'OK' };
  }

  // ─── Backoffice ──────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'List orders for the salon (owner/manager)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('orders')
  @UseGuards(JwtGuard, RolesGuard, FeatureGuard)
  @Roles('owner', 'manager')
  @RequiresFeature('ecommerce')
  async list() {
    const data = await this.orders.list();
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Update the status of an order (owner/manager)' })
  @ApiResponse({ status: 200, description: 'Order updated.' })
  @ApiBearerAuth()
  @Patch('orders/:id/status')
  @UseGuards(JwtGuard, RolesGuard, FeatureGuard)
  @Roles('owner', 'manager')
  @RequiresFeature('ecommerce')
  @Destructive()
  async status(@Param('id') id: string, @Body() dto: UpdateOrderStatusDto) {
    const data = await this.orders.updateStatus(id, dto.status);
    return { data, message: 'Order updated.' };
  }
}
