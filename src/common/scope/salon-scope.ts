import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { AuthUser } from '../decorators/current-user.decorator';

export interface SalonScope {
  salonId: string;
}

/**
 * Convention #3 — chaque query backoffice DOIT passer par ce helper.
 * Renvoie le `salonId` du user authentifié. En V1 single-salon, fallback sur
 * `DEFAULT_SALON_ID` (injecté au boot depuis le salon seedé) si présent.
 */
export function getSalonScope(req: Request & { user?: AuthUser }): SalonScope {
  const fromUser = req.user?.salonId;
  const fallback = process.env.DEFAULT_SALON_ID;
  const salonId = fromUser || fallback;
  if (!salonId) {
    throw new ForbiddenException('No salon scope available for this request.');
  }
  return { salonId };
}
