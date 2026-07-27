import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { LocationService } from './location.service';
import { CreateLocationDto, ListLocationsQueryDto, UpdateLocationDto } from './dto/location.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { LocationDocument } from './schemas/location.schema';

/**
 * Locations (Sprint 1 v2, Prompt 1). Lecture = tout user authentifié ; create/edit/delete
 * = owner uniquement. Filtrage par locationIds du caller = Prompt 2 (TenantContext), pas
 * encore construit — en attendant, un staff voit toutes les locations de son tenant.
 */
@ApiTags('Locations')
@ApiBearerAuth()
@Controller('locations')
@UseGuards(JwtGuard, RolesGuard)
export class LocationController {
  constructor(private readonly locations: LocationService) {}

  @ApiOperation({ summary: 'List locations for the current salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  async list(
    @Req() req: Request,
    @Query() query: ListLocationsQueryDto,
  ): Promise<{ data: LocationDocument[]; message: string }> {
    const includeInactive = query.active === 'false';
    const data = await this.locations.findAllForTenant(getSalonScope(req), includeInactive);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Get the primary location for the current salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('primary')
  async primary(@Req() req: Request): Promise<{ data: LocationDocument; message: string }> {
    const data = await this.locations.findPrimary(getSalonScope(req));
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Create a new location' })
  @ApiResponse({ status: 201, description: 'Location created.' })
  @Post()
  @Roles('owner')
  async create(
    @Req() req: Request,
    @Body() dto: CreateLocationDto,
  ): Promise<{ data: LocationDocument; message: string }> {
    const data = await this.locations.create(getSalonScope(req), dto);
    return { data, message: 'Location created.' };
  }

  @ApiOperation({ summary: 'Update a location' })
  @ApiResponse({ status: 200, description: 'Location updated.' })
  @Patch(':id')
  @Roles('owner')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateLocationDto,
  ): Promise<{ data: LocationDocument; message: string }> {
    const data = await this.locations.update(getSalonScope(req), id, dto);
    return { data, message: 'Location updated.' };
  }

  @ApiOperation({ summary: 'Deactivate (soft-delete) a location' })
  @ApiResponse({ status: 200, description: 'Location deactivated.' })
  @Delete(':id')
  @Roles('owner')
  async remove(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ data: LocationDocument; message: string }> {
    const data = await this.locations.deactivate(getSalonScope(req), id);
    return { data, message: 'Location deactivated.' };
  }
}
