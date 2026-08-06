import { CanActivate, ExecutionContext, Injectable, Logger, RawBodyRequest, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';

const REPLAY_WINDOW_MS = 60_000;

/**
 * Garde générique pour toutes les routes `/internal/*` — le Control Plane (Sprint 3, pas
 * encore construit) les appellera à la place d'un JWT (ces routes agissent AU-DESSUS du
 * contexte tenant, avant qu'aucun utilisateur/staff n'existe). Signature sur le rawBody
 * EXACT (`main.ts` : `rawBody: true`), jamais un `JSON.stringify(req.body)` reconstruit qui
 * pourrait diverger de ce que l'émetteur a signé.
 *
 * Remplace le check HMAC ad-hoc écrit en dur dans `EntitlementsController.invalidate()`
 * (Prompt 7, notée provisoire dès l'origine) — substitution mécanique, mêmes en-têtes.
 *
 * [Delta 4, Sprint 3 v2 Prompt 9] Rotation symétrique : accepte une signature valide avec
 * `CP_SHARED_SECRET` OU `CP_SHARED_SECRET_PREVIOUS` — pendant une rotation, le CP se remet à
 * signer avec le nouveau secret immédiatement, mais le DP doit continuer d'accepter
 * l'ancien jusqu'à ce que l'opérateur retire `CP_SHARED_SECRET_PREVIOUS` de la config,
 * sans quoi toute requête CP→DP en vol au moment du switch échouerait (fenêtre de coupure).
 * Même schéma que le sens inverse déjà en place côté CP (`InternalHmacGuard`, DP→CP pull).
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAuthGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();

    const candidateSecrets = [process.env.CP_SHARED_SECRET, process.env.CP_SHARED_SECRET_PREVIOUS].filter(
      (s): s is string => !!s,
    );
    if (candidateSecrets.length === 0) {
      this.logger.error('CP_SHARED_SECRET not configured — rejecting all /internal/* requests.');
      throw new UnauthorizedException('Internal API not configured.');
    }

    const allowedIps = process.env.CP_ALLOWED_IPS?.split(',').map((ip) => ip.trim()).filter(Boolean);
    if (allowedIps?.length) {
      const remoteIp = req.ip ?? req.socket.remoteAddress ?? '';
      if (!allowedIps.includes(remoteIp)) {
        this.logger.warn(`Rejected /internal request from disallowed IP ${remoteIp}.`);
        throw new UnauthorizedException('IP not allowed.');
      }
    }

    const signature = req.header('x-cp-signature');
    const timestamp = req.header('x-cp-timestamp');
    if (!signature || !timestamp) {
      this.logger.warn('Rejected /internal request: missing signature headers.');
      throw new UnauthorizedException('Missing signature headers.');
    }

    const skewMs = Math.abs(Date.now() - Number(timestamp));
    if (!Number.isFinite(skewMs) || skewMs > REPLAY_WINDOW_MS) {
      this.logger.warn(`Rejected /internal request: timestamp skew ${skewMs}ms exceeds ${REPLAY_WINDOW_MS}ms.`);
      throw new UnauthorizedException('Signature timestamp out of range.');
    }

    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const signatureBuf = this.safeHexBuffer(signature);
    const valid =
      signatureBuf !== null &&
      candidateSecrets.some((secret) => {
        const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
        const expectedBuf = Buffer.from(expected, 'hex');
        return expectedBuf.length === signatureBuf.length && crypto.timingSafeEqual(expectedBuf, signatureBuf);
      });

    if (!valid) {
      this.logger.warn(`Rejected /internal request: invalid signature on ${req.method} ${req.path}.`);
      throw new UnauthorizedException('Invalid signature.');
    }

    return true;
  }

  private safeHexBuffer(value: string): Buffer | null {
    if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
    return Buffer.from(value, 'hex');
  }
}
