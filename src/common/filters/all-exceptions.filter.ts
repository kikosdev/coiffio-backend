import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Convention #2 — toute erreur est sérialisée dans la même enveloppe
 * `{ data, message, statusCode }`. Les champs additionnels portés par une HttpException
 * (ex. `conflicts` du blocage de congé #6, ou un re-choix de créneau sur 409 booking)
 * sont transportés dans `data` pour rester exploitables côté client, sans casser l'enveloppe.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let data: unknown = null;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const r = body as Record<string, unknown>;
        const m = r.message;
        message = Array.isArray(m) ? m.join(', ') : String(m ?? exception.message);
        // Conserve les champs additionnels (hors message/statusCode/error) dans `data`.
        const { message: _m, statusCode: _s, error: _e, ...rest } = r;
        void _m;
        void _s;
        void _e;
        if (Object.keys(rest).length > 0) data = rest;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.message, exception.stack);
    }

    res.status(statusCode).json({ data, message, statusCode });
  }
}
