import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { SalonRole, SalonRoleDocument } from './schemas/salon-role.schema';
import { SalonScope } from '../common/scope/salon-scope';
import { UpdateSalonDto, CreateRoleDto, UpdateRoleDto } from './dto/settings.dto';
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from './permissions';

const SYSTEM_ROLE_COLORS: Record<string, string> = {
  owner: '#1C1612',
  manager: '#9A7B4F',
  stylist: '#B89968',
  colorist: '#C9A227',
  client: '#8A8076',
};
const SYSTEM_ROLE_NAMES = ['owner', 'manager', 'stylist', 'colorist', 'client'] as const;

@Injectable()
export class SettingsService {
  constructor(
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(SalonRole.name) private readonly roleModel: Model<SalonRoleDocument>,
  ) {}

  // ── Salon config ─────────────────────────────────────────────────────────────

  async getSalon(scope: SalonScope): Promise<SalonDocument> {
    const salon = await this.salonModel.findById(scope.salonId);
    if (!salon) throw new NotFoundException('Salon introuvable.');
    return salon;
  }

  async updateSalon(scope: SalonScope, dto: UpdateSalonDto): Promise<SalonDocument> {
    const salon = await this.salonModel.findByIdAndUpdate(
      scope.salonId,
      { $set: dto },
      { new: true, runValidators: true },
    );
    if (!salon) throw new NotFoundException('Salon introuvable.');
    return salon;
  }

  // ── Roles ─────────────────────────────────────────────────────────────────────

  private async ensureSystemRoles(salonId: string): Promise<void> {
    for (const name of SYSTEM_ROLE_NAMES) {
      await this.roleModel.updateOne(
        { salonId, name, isSystem: true },
        {
          $setOnInsert: {
            salonId,
            name,
            isSystem: true,
            permissions: ROLE_DEFAULT_PERMISSIONS[name] ?? [],
            color: SYSTEM_ROLE_COLORS[name] ?? '#B89968',
          },
        },
        { upsert: true },
      );
    }
  }

  async getRoles(scope: SalonScope): Promise<SalonRoleDocument[]> {
    await this.ensureSystemRoles(scope.salonId);
    return this.roleModel
      .find({ salonId: scope.salonId })
      .sort({ isSystem: -1, name: 1 });
  }

  async createRole(scope: SalonScope, dto: CreateRoleDto): Promise<SalonRoleDocument> {
    const invalid = dto.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
    if (invalid.length) {
      throw new BadRequestException(`Permissions inconnues : ${invalid.join(', ')}`);
    }
    return this.roleModel.create({
      salonId: scope.salonId,
      name: dto.name,
      isSystem: false,
      permissions: dto.permissions,
      color: dto.color ?? '#B89968',
    });
  }

  async updateRole(scope: SalonScope, id: string, dto: UpdateRoleDto): Promise<SalonRoleDocument> {
    const role = await this.roleModel.findOne({ _id: id, salonId: scope.salonId });
    if (!role) throw new NotFoundException('Rôle introuvable.');
    if (role.isSystem) throw new BadRequestException('Les rôles système ne peuvent pas être modifiés.');
    if (dto.permissions) {
      const invalid = dto.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
      if (invalid.length) throw new BadRequestException(`Permissions inconnues : ${invalid.join(', ')}`);
    }
    Object.assign(role, dto);
    return role.save();
  }

  async deleteRole(scope: SalonScope, id: string): Promise<void> {
    const role = await this.roleModel.findOne({ _id: id, salonId: scope.salonId });
    if (!role) throw new NotFoundException('Rôle introuvable.');
    if (role.isSystem) throw new BadRequestException('Les rôles système ne peuvent pas être supprimés.');
    await role.deleteOne();
  }

  async getPermissionCatalog() {
    return PERMISSIONS;
  }
}
