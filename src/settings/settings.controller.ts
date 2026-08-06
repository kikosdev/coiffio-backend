import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { CreateRoleDto, UpdateRoleDto, UpdateSalonDto } from './dto/settings.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Destructive } from '../common/decorators/destructive.decorator';

/**
 * Sprint 10 — paramètres salon (config + rôles). Owner voit et modifie tout.
 * Manager peut lire la config et les rôles mais ne peut pas les modifier.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings')
@UseGuards(JwtGuard, RolesGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // ── Salon config ──────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Get the current salon configuration' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('salon')
  @Roles('owner', 'manager')
  async getSalon() {
    const data = await this.settings.getSalon();
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Update the salon configuration' })
  @ApiResponse({ status: 200, description: 'Paramètres enregistrés.' })
  @Patch('salon')
  @Roles('owner')
  async updateSalon(@Body() dto: UpdateSalonDto) {
    const data = await this.settings.updateSalon(dto);
    return { data, message: 'Paramètres enregistrés.' };
  }

  // ── Permission catalog ────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Get the catalog of available permissions' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('permissions')
  @Roles('owner', 'manager')
  async getPermissions() {
    const data = await this.settings.getPermissionCatalog();
    return { data, message: 'OK' };
  }

  // ── Roles ─────────────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'List roles defined for the current salon' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('roles')
  @Roles('owner', 'manager')
  async getRoles() {
    const data = await this.settings.getRoles();
    return { data, message: 'OK' };
  }

  @ApiOperation({ summary: 'Create a new role for the current salon' })
  @ApiResponse({ status: 201, description: 'Rôle créé.' })
  @Post('roles')
  @Roles('owner')
  async createRole(@Body() dto: CreateRoleDto) {
    const data = await this.settings.createRole(dto);
    return { data, message: 'Rôle créé.' };
  }

  @ApiOperation({ summary: 'Update an existing role' })
  @ApiResponse({ status: 200, description: 'Rôle mis à jour.' })
  @Patch('roles/:id')
  @Roles('owner')
  async updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    const data = await this.settings.updateRole(id, dto);
    return { data, message: 'Rôle mis à jour.' };
  }

  @ApiOperation({ summary: 'Delete a role' })
  @ApiResponse({ status: 200, description: 'Rôle supprimé.' })
  @Delete('roles/:id')
  @Roles('owner')
  @Destructive()
  async deleteRole(@Param('id') id: string) {
    await this.settings.deleteRole(id);
    return { data: null, message: 'Rôle supprimé.' };
  }
}
