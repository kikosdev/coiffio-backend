import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { OrdersService, CartCtx } from './orders.service';
import { AddCartItemDto, CheckoutDto, UpdateCartItemDto, UpdateOrderStatusDto } from './dto/orders.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

const CART_COOKIE = 'cartToken';
const CART_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/** Storefront & commandes (Sprint 7). Panier invité cookie httpOnly, checkout pickup-only #5. */
@ApiTags('Orders')
@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

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
  @Get('shop/products')
  async shop(@Req() req: Request) {
    const data = await this.orders.shopProducts(getSalonScope(req));
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Get the current cart (guest cookie or authenticated client)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('cart')
  @UseGuards(OptionalJwtGuard)
  async getCart(@Req() req: Request, @CurrentUser() user: AuthUser | undefined) {
    const { cart } = await this.orders.getCart(getSalonScope(req), this.ctx(req, user));
    return { data: cart ?? { items: [] }, message: 'OK' };
  }

  @ApiOperation({ summary: 'Add an item to the cart' })
  @ApiResponse({ status: 201, description: 'Added to cart.' })
  @Post('cart/items')
  @UseGuards(OptionalJwtGuard)
  async addItem(@Req() req: Request, @CurrentUser() user: AuthUser | undefined, @Body() dto: AddCartItemDto, @Res({ passthrough: true }) res: Response) {
    const { cart, newToken } = await this.orders.addItem(getSalonScope(req), this.ctx(req, user), dto.productId, dto.qty);
    if (newToken) this.setCartCookie(res, newToken);
    return { data: cart, message: 'Added to cart.' };
  }

  @ApiOperation({ summary: 'Update the quantity of a cart item' })
  @ApiResponse({ status: 200, description: 'Updated.' })
  @Patch('cart/items/:productId')
  @UseGuards(OptionalJwtGuard)
  async updateItemQty(@Req() req: Request, @CurrentUser() user: AuthUser | undefined, @Param('productId') productId: string, @Body() dto: UpdateCartItemDto) {
    const data = await this.orders.updateItemQty(getSalonScope(req), this.ctx(req, user), productId, dto.qty);
    return { data, message: 'Updated.' };
  }

  @ApiOperation({ summary: 'Remove an item from the cart' })
  @ApiResponse({ status: 200, description: 'Removed.' })
  @Delete('cart/items/:productId')
  @UseGuards(OptionalJwtGuard)
  async removeItem(@Req() req: Request, @CurrentUser() user: AuthUser | undefined, @Param('productId') productId: string) {
    const data = await this.orders.removeItem(getSalonScope(req), this.ctx(req, user), productId);
    return { data, message: 'Removed.' };
  }

  @ApiOperation({ summary: "Merge a guest cart into the authenticated client's cart" })
  @ApiResponse({ status: 201, description: 'Cart merged.' })
  @ApiBearerAuth()
  @Post('cart/merge')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('client')
  async merge(@Req() req: Request, @CurrentUser() user: AuthUser) {
    const cartToken = (req as Request & { cookies?: Record<string, string> }).cookies?.[CART_COOKIE];
    const data = await this.orders.merge(getSalonScope(req), user.sub, cartToken);
    return { data, message: 'Cart merged.' };
  }

  @ApiOperation({ summary: 'Checkout the cart and place an order (pickup-only)' })
  @ApiResponse({ status: 201, description: 'Order placed.' })
  @Post('orders')
  @UseGuards(OptionalJwtGuard)
  async checkout(@Req() req: Request, @CurrentUser() user: AuthUser | undefined, @Body() dto: CheckoutDto) {
    const data = await this.orders.checkout(getSalonScope(req), this.ctx(req, user), dto);
    return { data, message: 'Order placed.' };
  }

  @ApiOperation({ summary: 'Track an order by its track token' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('track/order/:trackToken')
  async track(@Req() req: Request, @Param('trackToken') trackToken: string) {
    const data = await this.orders.track(getSalonScope(req), trackToken);
    return { data, message: 'OK' };
  }

  // ─── Backoffice ──────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'List orders for the salon (owner/manager)' })
  @ApiResponse({ status: 200, description: 'OK' })
  @ApiBearerAuth()
  @Get('orders')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async list(@Req() req: Request) {
    const data = await this.orders.list(getSalonScope(req));
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Update the status of an order (owner/manager)' })
  @ApiResponse({ status: 200, description: 'Order updated.' })
  @ApiBearerAuth()
  @Patch('orders/:id/status')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('owner', 'manager')
  async status(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateOrderStatusDto) {
    const data = await this.orders.updateStatus(getSalonScope(req), id, dto.status);
    return { data, message: 'Order updated.' };
  }
}
