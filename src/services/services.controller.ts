import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard }   from '../common/roles.guard';
import { Roles }        from '../common/roles.decorator';
import { UserRole }     from '../schemas/user.schema';
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { QueryServicesDto } from './dto/query-services.dto';

@Controller('services')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  /* ── Public-ish (any authenticated user) ── */

  @Roles(UserRole.OWNER, UserRole.SUPERVISOR, UserRole.STAFF, UserRole.CLIENT)
  @Get()
  findAll(@Query() query: QueryServicesDto) {
    return this.servicesService.findAll(query);
  }

  @Roles(UserRole.OWNER, UserRole.SUPERVISOR, UserRole.STAFF, UserRole.CLIENT)
  @Get('categories')
  findCategories() {
    return this.servicesService.findCategories();
  }

  @Roles(UserRole.OWNER, UserRole.SUPERVISOR)
  @Get('popular')
  findPopular() {
    return this.servicesService.findPopular();
  }

  @Roles(UserRole.OWNER, UserRole.SUPERVISOR, UserRole.STAFF, UserRole.CLIENT)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.servicesService.findOne(id);
  }

  /* ── Owner / Supervisor only ── */

  @Roles(UserRole.OWNER, UserRole.SUPERVISOR)
  @Post()
  create(@Body() dto: CreateServiceDto) {
    return this.servicesService.create(dto);
  }

  @Roles(UserRole.OWNER, UserRole.SUPERVISOR)
  @Patch('reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  reorder(@Body() body: { items: { id: string; displayOrder: number }[] }) {
    return this.servicesService.reorder(body.items);
  }

  @Roles(UserRole.OWNER, UserRole.SUPERVISOR)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateServiceDto) {
    return this.servicesService.update(id, dto);
  }

  @Roles(UserRole.OWNER, UserRole.SUPERVISOR)
  @Patch(':id/toggle-active')
  toggleActive(@Param('id') id: string) {
    return this.servicesService.toggleActive(id);
  }

  /* ── Owner only ── */

  @Roles(UserRole.OWNER)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.servicesService.remove(id);
  }
}
