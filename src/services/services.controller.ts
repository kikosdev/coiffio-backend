import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ServicesService } from './services.service';
import { CreateServiceDto, ListServicesQueryDto, UpdateServiceDto, UpdateServiceDoseConfigDto } from './dto/service.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ServiceDocument } from './schemas/service.schema';
import { Destructive } from '../common/decorators/destructive.decorator';

/**
 * Catalogue services (Sprint 2). Matrice : lecture = tous (authentifiés) ;
 * create/edit/delete = owner·manager. Le scope tenant est résolu par le plugin
 * (TenantContext, Prompt 3/6b) — plus besoin de le passer explicitement au service.
 */
@ApiTags('Services')
@ApiBearerAuth()
@Controller('services')
@UseGuards(JwtGuard, RolesGuard)
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  /**
   * Catalogue BACKOFFICE, scopé au salon du membership actif. `@Roles` explicite (au lieu de
   * "tout user authentifié") parce qu'un CLIENT n'a pas de tenant actif : il tombait sur un 500
   * du plugin de scope ("No tenant context available") au lieu d'un 403 propre. Aucune fuite
   * dans les deux cas — le plugin bloque — mais l'erreur doit dire la vérité. Le catalogue
   * public du client est `GET /:salonSlug/book/services`, jamais cette route.
   */
  @ApiOperation({ summary: 'List services in the catalog for the current salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  @Roles('owner', 'manager', 'stylist', 'colorist')
  async list(
    @Query() query: ListServicesQueryDto,
  ): Promise<{ data: ServiceDocument[]; message: string }> {
    const data = await this.services.findAll(query.gender);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Create a new service in the catalog' })
  @ApiResponse({ status: 201, description: 'Service created.' })
  @Post()
  @Roles('owner', 'manager')
  async create(
    @Body() dto: CreateServiceDto,
  ): Promise<{ data: ServiceDocument; message: string }> {
    const data = await this.services.create(dto);
    return { data, message: 'Service created.' };
  }

  @ApiOperation({ summary: 'Update a service in the catalog' })
  @ApiResponse({ status: 200, description: 'Service updated.' })
  @Patch(':id')
  @Roles('owner', 'manager')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateServiceDto,
  ): Promise<{ data: ServiceDocument; message: string }> {
    const data = await this.services.update(id, dto);
    return { data, message: 'Service updated.' };
  }

  /** LC-2/LC-T8 (SKILL_loss_control_doses.md) — owner-only, séparé de `update()` (owner+manager). */
  @ApiOperation({ summary: 'Configure the loss-control dose theoretical (doseConfig[]) for a service' })
  @ApiResponse({ status: 200, description: 'Dose config updated.' })
  @Patch(':id/dose-config')
  @Roles('owner')
  async updateDoseConfig(
    @Param('id') id: string,
    @Body() dto: UpdateServiceDoseConfigDto,
  ): Promise<{ data: ServiceDocument; message: string }> {
    const data = await this.services.updateDoseConfig(id, dto);
    return { data, message: 'Dose config updated.' };
  }

  @ApiOperation({ summary: 'Archive (soft-delete) a service from the catalog' })
  @ApiResponse({ status: 200, description: 'Service archived.' })
  @Delete(':id')
  @Roles('owner', 'manager')
  @Destructive()
  async remove(
    @Param('id') id: string,
  ): Promise<{ data: ServiceDocument; message: string }> {
    const data = await this.services.softDelete(id);
    return { data, message: 'Service archived.' };
  }
}
