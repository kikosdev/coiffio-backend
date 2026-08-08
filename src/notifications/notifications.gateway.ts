import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MembershipClaim } from '../common/decorators/current-user.decorator';

const allowedOrigins = [
  process.env.FRONTEND_ORIGIN,
  process.env.DESKTOP_ORIGIN,
  process.env.BACKOFFICE_ORIGIN,
  ...(process.env.MOBILE_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? []),
].filter((origin): origin is string => !!origin);

/**
 * Gateway Socket.io (Sprint 8). Auth JWT AU HANDSHAKE ; rooms jointes CÔTÉ SERVEUR
 * uniquement (salon:{id}, user:{sub}, role:{role}). Aucun join déclenché par le client
 * (faille du build précédent corrigée).
 */
@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  },
})
export class NotificationsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(private readonly jwt: JwtService) {}

  /**
   * Sprint 2 v2 Prompt 2 : le JWT ne porte plus `salonId`/`role`/`staffId` à la racine —
   * il porte `memberships[]`. Un socket est une connexion PERSISTANTE (pas une requête
   * HTTP unique) sans notion de "tenant actif" — contrairement au middleware HTTP, qui
   * DOIT trancher un seul tenant par requête, un socket rejoint la room `salon:{id}` de
   * CHAQUE membership : un user multi-tenant reste notifié pour tous ses salons sans
   * sélection explicite. Élargit strictement ce qu'un socket mono-tenant recevait déjà
   * (jamais moins), donc sans risque pour les users actuels (audit : tous mono-tenant
   * aujourd'hui). Lit `memberships[]` directement depuis le JWT (pas de relecture DB
   * cachée ici, contrairement au middleware HTTP) — une révocation met donc jusqu'à 7j
   * (JWT_EXPIRES, pas de refresh ce sprint) à cesser les notifications socket ; acceptable
   * pour ce canal (lecture seule, pas une autorisation d'action).
   *
   * ⚠️ FALLBACK TRANSITOIRE identique au middleware HTTP : un ancien token (avant ce
   * déploiement) n'a pas `memberships`, reconstruit une entrée unique depuis
   * `salonId`/`role`/`staffId` à la racine. À supprimer 7 jours après le déploiement.
   */
  async handleConnection(socket: Socket): Promise<void> {
    const auth = socket.handshake.auth as { token?: string } | undefined;
    const header = socket.handshake.headers.authorization;
    const token = auth?.token || (header && header.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token) {
      socket.disconnect(true);
      return;
    }
    try {
      const payload = await this.jwt.verifyAsync<Record<string, unknown>>(token);
      const sub = payload.sub as string | undefined;
      if (!sub) {
        socket.disconnect(true);
        return;
      }
      const memberships: MembershipClaim[] = Array.isArray(payload.memberships)
        ? (payload.memberships as MembershipClaim[])
        : payload.salonId
          ? [{ tenantId: payload.salonId as string, role: payload.role as MembershipClaim['role'], staffId: payload.staffId as string | undefined, locationIds: [] }]
          : [];

      // Rooms jointes par le SERVEUR depuis le JWT (jamais par un message client).
      socket.join(`user:${sub}`);
      for (const m of memberships) {
        socket.join(`salon:${m.tenantId}`);
        socket.join(`role:${m.role}`);
        if (m.staffId) socket.join(`staff:${m.staffId}`);
      }
      (socket.data as { user?: { sub: string; memberships: MembershipClaim[] } }).user = { sub, memberships };
    } catch {
      socket.disconnect(true);
    }
  }

  emitToRoom(room: string, event: string, payload: unknown): void {
    if (this.server) this.server.to(room).emit(event, payload);
  }
}
