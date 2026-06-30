import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ServicesService } from './services.service';
import { CreateServiceDto, ListServicesQueryDto, UpdateServiceDto } from './dto/service.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { ServiceDocument } from './schemas/service.schema';

/**
 * Catalogue services (Sprint 2). Matrice : lecture = tous (authentifiés) ;
 * create/edit/delete = owner·manager. getSalonScope() partout. Enveloppe standard.
 */
@Controller('services')
@UseGuards(JwtGuard, RolesGuard)
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  // Lecture : tout user authentifié (pas de @Roles ⇒ RolesGuard laisse passer).
  @Get()
  async list(
    @Req() req: Request,
    @Query() query: ListServicesQueryDto,
  ): Promise<{ data: ServiceDocument[]; message: string }> {
    const data = await this.services.findAll(getSalonScope(req), query.gender);
    return { data, message: 'OK' };
  }

  @Post()
  @Roles('owner', 'manager')
  async create(
    @Req() req: Request,
    @Body() dto: CreateServiceDto,
  ): Promise<{ data: ServiceDocument; message: string }> {
    const data = await this.services.create(getSalonScope(req), dto);
    return { data, message: 'Service created.' };
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateServiceDto,
  ): Promise<{ data: ServiceDocument; message: string }> {
    const data = await this.services.update(getSalonScope(req), id, dto);
    return { data, message: 'Service updated.' };
  }

  @Delete(':id')
  @Roles('owner', 'manager')
  async remove(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ data: ServiceDocument; message: string }> {
    const data = await this.services.softDelete(getSalonScope(req), id);
    return { data, message: 'Service archived.' };
  }
}
