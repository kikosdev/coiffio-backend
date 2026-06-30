import { SetMetadata } from '@nestjs/common';
import { Role } from './current-user.decorator';

export const ROLES_KEY = 'roles';

/**
 * Déclare les rôles autorisés sur un handler/contrôleur (cf. matrice RBAC, SKILL.md).
 * Usage : `@Roles('owner', 'manager')`.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
