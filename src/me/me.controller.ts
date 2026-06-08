import { Controller, Get, Param, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { OrdersService } from '../orders/orders.service';

@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get('orders')
  myOrders(@Request() req: { user: { sub: string } }) {
    return this.ordersService.findByUser(req.user.sub);
  }

  @Get('orders/:id')
  myOrder(@Param('id') id: string, @Request() req: { user: { sub: string } }) {
    return this.ordersService.findOne(id);
  }

  @Post('orders/:id/cancel')
  cancel(@Param('id') id: string, @Request() req: { user: { sub: string } }) {
    return this.ordersService.cancelByUser(id, req.user.sub);
  }
}
