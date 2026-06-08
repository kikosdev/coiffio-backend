import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product, ProductDocument } from '../schemas/product.schema';
import { OrdersService } from '../orders/orders.service';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { CreateOrderDto } from '../orders/dto/create-order.dto';
import { JwtAuthOptionalGuard } from '../common/jwt-auth-optional.guard';

@Controller('public')
export class PublicController {
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Order.name)   private orderModel:   Model<OrderDocument>,
    private readonly ordersService: OrdersService,
  ) {}

  // GET /api/public/products  — public catalogue
  @Get('products')
  async getProducts(
    @Query('category') category?: string,
    @Query('search')   search?: string,
    @Query('page')     page = '0',
    @Query('limit')    limit = '20',
  ) {
    const filter: Record<string, unknown> = { isPublic: true, isActive: true, stockQuantity: { $gt: 0 } };
    if (category) filter.category = category;
    if (search)   filter['$or']   = [
      { name:        { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
    ];

    const skip  = parseInt(page, 10)  * parseInt(limit, 10);
    const lim   = parseInt(limit, 10);

    const [items, total] = await Promise.all([
      this.productModel.find(filter).skip(skip).limit(lim).lean(),
      this.productModel.countDocuments(filter),
    ]);

    return { items, total, page: parseInt(page, 10), limit: lim };
  }

  // GET /api/public/products/:id
  @Get('products/:id')
  async getProduct(@Param('id') id: string) {
    const product = await this.productModel.findOne({ _id: id, isPublic: true, isActive: true }).lean();
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  // POST /api/public/orders — create order (guest or authenticated)
  @UseGuards(JwtAuthOptionalGuard)
  @Post('orders')
  createOrder(
    @Body() dto: CreateOrderDto,
    @Request() req: { user?: { sub: string; email: string; role: string } },
  ) {
    return this.ordersService.create(dto, req.user ?? undefined);
  }

  // GET /api/public/orders/:orderNumber?email=... — order tracking (guest)
  @Get('orders/:orderNumber')
  async trackOrder(
    @Param('orderNumber') orderNumber: string,
    @Query('email')       email?: string,
  ) {
    return this.ordersService.findByOrderNumber(orderNumber, email);
  }
}
