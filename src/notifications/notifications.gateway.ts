import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '../schemas/user.schema';

interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  staffId?: string;
}

@WebSocketGateway({
  cors: { origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true },
  namespace: '/ws',
})
export class NotificationsGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(private readonly jwt: JwtService) {}

  handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string;
      if (!token) throw new Error('No token');
      const payload = this.jwt.verify<JwtPayload>(token);
      void client.join(`user:${payload.sub}`);
      void client.join(`role:${payload.role}`);
    } catch {
      client.disconnect();
    }
  }

  emitToUser(userId: string, data: unknown) {
    this.server.to(`user:${userId}`).emit('notification', data);
  }

  emitToRole(role: UserRole, data: unknown) {
    this.server.to(`role:${role}`).emit('notification', data);
  }
}
