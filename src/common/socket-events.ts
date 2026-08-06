/**
 * Source unique des noms d'événements Socket.io (convention #9 — copiée VERBATIM côté
 * frontend dans `salon-frontend/src/shared/socket-events.ts`). Remplie au Sprint 8.
 */
export const SOCKET_EVENTS = {
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  ORDER_CREATED: 'order.created',
  STOCK_LOW: 'stock.low',
  STOCK_OUT: 'stock.out',
  SALE_RECORDED: 'sale.recorded',
  LEAVE_REQUESTED: 'leave.requested',
  STAFF_JOINED: 'staff.joined',
} as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
