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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
@ApiTags('Services')
@ApiBearerAuth()
@Controller('services')
@UseGuards(JwtGuard, RolesGuard)
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  // Lecture : tout user authentifié (pas de @Roles ⇒ RolesGuard laisse passer).
  @ApiOperation({ summary: 'List services in the catalog for the current salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  async list(
    @Req() req: Request,
    @Query() query: ListServicesQueryDto,
  ): Promise<{ data: ServiceDocument[]; message: string }> {
    const data = await this.services.findAll(getSalonScope(req), query.gender);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Create a new service in the catalog' })
  @ApiResponse({ status: 201, description: 'Service created.' })
  @Post()
  @Roles('owner', 'manager')
  async create(
    @Req() req: Request,
    @Body() dto: CreateServiceDto,
  ): Promise<{ data: ServiceDocument; message: string }> {
    const data = await this.services.create(getSalonScope(req), dto);
    return { data, message: 'Service created.' };
  }

  @ApiOperation({ summary: 'Update a service in the catalog' })
  @ApiResponse({ status: 200, description: 'Service updated.' })
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

  @ApiOperation({ summary: 'Archive (soft-delete) a service from the catalog' })
  @ApiResponse({ status: 200, description: 'Service archived.' })
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
