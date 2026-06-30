import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Gateway Socket.io (Sprint 8). Auth JWT AU HANDSHAKE ; rooms jointes CÔTÉ SERVEUR
 * uniquement (salon:{id}, user:{sub}, role:{role}). Aucun join déclenché par le client
 * (faille du build précédent corrigée).
 */
@WebSocketGateway({ cors: { origin: process.env.FRONTEND_ORIGIN, credentials: true } })
export class NotificationsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(socket: Socket): Promise<void> {
    const auth = socket.handshake.auth as { token?: string } | undefined;
    const header = socket.handshake.headers.authorization;
    const token = auth?.token || (header && header.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token) {
      socket.disconnect(true);
      return;
    }
    try {
      const user = await this.jwt.verifyAsync<AuthUser>(token);
      // Rooms jointes par le SERVEUR depuis le JWT (jamais par un message client).
      socket.join(`salon:${user.salonId}`);
      socket.join(`user:${user.sub}`);
      socket.join(`role:${user.role}`);
      (socket.data as { user?: AuthUser }).user = user;
    } catch {
      socket.disconnect(true);
    }
  }

  emitToRoom(room: string, event: string, payload: unknown): void {
    if (this.server) this.server.to(room).emit(event, payload);
  }
}
