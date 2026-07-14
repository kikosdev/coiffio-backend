import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientsService, ClientDetail, ClientListItem } from './clients.service';
import { CreateClientDto, ListClientsQueryDto, UpdateClientDto } from './dto/client.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';
import { ClientDocument } from './schemas/client.schema';

/**
 * CRM (Sprint 2). Matrice : create/edit client = owner·manager·stylist·colorist.
 * Toutes les queries passent par getSalonScope() (convention #3). Enveloppe standard.
 */
@ApiTags('Clients')
@ApiBearerAuth()
@Controller('clients')
@UseGuards(JwtGuard, RolesGuard)
@Roles('owner', 'manager', 'stylist', 'colorist')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @ApiOperation({ summary: 'List clients for the salon, optionally filtered by search query' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get()
  async list(
    @Req() req: Request,
    @Query() query: ListClientsQueryDto,
  ): Promise<{ data: ClientListItem[]; message: string }> {
    const data = await this.clients.findAll(getSalonScope(req), query.q);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Get a single client by id' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get(':id')
  async detail(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ data: ClientDetail; message: string }> {
    const data = await this.clients.findOne(getSalonScope(req), id);
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Create a new client' })
  @ApiResponse({ status: 201, description: 'Client saved.' })
  @Post()
  async create(
    @Req() req: Request,
    @Body() dto: CreateClientDto,
  ): Promise<{ data: ClientDocument; message: string }> {
    const data = await this.clients.create(getSalonScope(req), dto);
    return { data, message: 'Client saved.' };
  }

  @ApiOperation({ summary: 'Update an existing client' })
  @ApiResponse({ status: 200, description: 'Client updated.' })
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateClientDto,
  ): Promise<{ data: ClientDocument; message: string }> {
    const data = await this.clients.update(getSalonScope(req), id, dto);
    return { data, message: 'Client updated.' };
  }
}
