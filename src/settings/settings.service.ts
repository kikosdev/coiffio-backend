import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { SalonRole, SalonRoleDocument } from './schemas/salon-role.schema';
import { UpdateSalonDto, CreateRoleDto, UpdateRoleDto, UpdateLossControlDto } from './dto/settings.dto';
import { getTenantContext } from '../common/tenant/tenant-context';
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

  async getSalon(): Promise<SalonDocument> {
    // `salons` est UNSCOPED (le doc tenant lui-même) — pas un filtre `salonId`, un lookup
    // par _id, donc toujours besoin du tenantId explicite ici (le plugin ne s'en charge
    // pas pour cette collection).
    const salon = await this.salonModel.findById(getTenantContext().tenantId);
    if (!salon) throw new NotFoundException('Salon introuvable.');
    return salon;
  }

  async updateSalon(dto: UpdateSalonDto): Promise<SalonDocument> {
    const salon = await this.salonModel.findByIdAndUpdate(
      getTenantContext().tenantId,
      { $set: dto },
      { new: true, runValidators: true },
    );
    if (!salon) throw new NotFoundException('Salon introuvable.');
    return salon;
  }

  /**
   * LC-7/LC-6.3/LC-8 (SKILL_loss_control_doses.md). ⚠️ Délibérément PAS `$set: dto` comme
   * `updateSalon()` — cette dernière écrase le document AU NIVEAU RACINE avec le DTO brut, ce
   * qui est sûr uniquement parce qu'`UpdateSalonDto` couvre des champs top-level (une clé
   * absente du DTO n'apparaît pas dans l'objet, donc jamais posée dans `$set`). Ici la cible
   * est une SOUS-structure (`lossControl.*`) : merge champ par champ, comme `ServicesService
   * .update()` / `StockService.updateDoses()` — aucun champ non envoyé ne peut être écrasé,
   * ni dans `lossControl` ni ailleurs sur `Salon` (mobile `salon-details.tsx` documente déjà
   * ce risque pour `updateSalon()`, cf. commentaire côté client).
   */
  async updateLossControl(dto: UpdateLossControlDto): Promise<SalonDocument> {
    const salon = await this.salonModel.findById(getTenantContext().tenantId);
    if (!salon) throw new NotFoundException('Salon introuvable.');
    if (dto.varianceThresholdPct !== undefined) salon.lossControl.varianceThresholdPct = dto.varianceThresholdPct;
    if (dto.extremeUsageFactor !== undefined) salon.lossControl.extremeUsageFactor = dto.extremeUsageFactor;
    if (dto.productCommissionPct !== undefined) salon.lossControl.productCommissionPct = dto.productCommissionPct;
    if (dto.alertsEnabled !== undefined) salon.lossControl.alertsEnabled = dto.alertsEnabled;
    await salon.save();
    return salon;
  }

  // ── Roles ─────────────────────────────────────────────────────────────────────

  private async ensureSystemRoles(): Promise<void> {
    for (const name of SYSTEM_ROLE_NAMES) {
      await this.roleModel.updateOne(
        { name, isSystem: true },
        {
          $setOnInsert: {
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

  async getRoles(): Promise<SalonRoleDocument[]> {
    await this.ensureSystemRoles();
    return this.roleModel
      .find({})
      .sort({ isSystem: -1, name: 1 });
  }

  async createRole(dto: CreateRoleDto): Promise<SalonRoleDocument> {
    const invalid = dto.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
    if (invalid.length) {
      throw new BadRequestException(`Permissions inconnues : ${invalid.join(', ')}`);
    }
    return this.roleModel.create({
      name: dto.name,
      isSystem: false,
      permissions: dto.permissions,
      color: dto.color ?? '#B89968',
    });
  }

  async updateRole(id: string, dto: UpdateRoleDto): Promise<SalonRoleDocument> {
    const role = await this.roleModel.findOne({ _id: id });
    if (!role) throw new NotFoundException('Rôle introuvable.');
    if (role.isSystem) throw new BadRequestException('Les rôles système ne peuvent pas être modifiés.');
    if (dto.permissions) {
      const invalid = dto.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
      if (invalid.length) throw new BadRequestException(`Permissions inconnues : ${invalid.join(', ')}`);
    }
    Object.assign(role, dto);
    return role.save();
  }

  async deleteRole(id: string): Promise<void> {
    const role = await this.roleModel.findOne({ _id: id });
    if (!role) throw new NotFoundException('Rôle introuvable.');
    if (role.isSystem) throw new BadRequestException('Les rôles système ne peuvent pas être supprimés.');
    await role.deleteOne();
  }

  async getPermissionCatalog() {
    return PERMISSIONS;
  }
}
