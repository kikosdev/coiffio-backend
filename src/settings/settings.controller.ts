import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { SettingsService } from './settings.service';
import { CreateRoleDto, UpdateRoleDto, UpdateSalonDto } from './dto/settings.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { getSalonScope } from '../common/scope/salon-scope';

/**
 * Sprint 10 — paramètres salon (config + rôles). Owner voit et modifie tout.
 * Manager peut lire la config et les rôles mais ne peut pas les modifier.
 */
@Controller('settings')
@UseGuards(JwtGuard, RolesGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // ── Salon config ──────────────────────────────────────────────────────────────

  @Get('salon')
  @Roles('owner', 'manager')
  async getSalon(@Req() req: Request) {
    const data = await this.settings.getSalon(getSalonScope(req));
    return { data, message: 'OK' };
  }

  @Patch('salon')
  @Roles('owner')
  async updateSalon(@Req() req: Request, @Body() dto: UpdateSalonDto) {
    const data = await this.settings.updateSalon(getSalonScope(req), dto);
    return { data, message: 'Paramètres enregistrés.' };
  }

  // ── Permission catalog ────────────────────────────────────────────────────────

  @Get('permissions')
  @Roles('owner', 'manager')
  async getPermissions() {
    const data = await this.settings.getPermissionCatalog();
    return { data, message: 'OK' };
  }

  // ── Roles ─────────────────────────────────────────────────────────────────────

  @Get('roles')
  @Roles('owner', 'manager')
  async getRoles(@Req() req: Request) {
    const data = await this.settings.getRoles(getSalonScope(req));
    return { data, message: 'OK' };
  }

  @Post('roles')
  @Roles('owner')
  async createRole(@Req() req: Request, @Body() dto: CreateRoleDto) {
    const data = await this.settings.createRole(getSalonScope(req), dto);
    return { data, message: 'Rôle créé.' };
  }

  @Patch('roles/:id')
  @Roles('owner')
  async updateRole(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    const data = await this.settings.updateRole(getSalonScope(req), id, dto);
    return { data, message: 'Rôle mis à jour.' };
  }

  @Delete('roles/:id')
  @Roles('owner')
  async deleteRole(@Req() req: Request, @Param('id') id: string) {
    await this.settings.deleteRole(getSalonScope(req), id);
    return { data: null, message: 'Rôle supprimé.' };
  }
}
