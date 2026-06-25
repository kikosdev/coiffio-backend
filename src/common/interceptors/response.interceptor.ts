import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Response } from 'express';

export interface ApiEnvelope<T> {
  data: T;
  message: string;
  statusCode: number;
}

/**
 * Convention #1 — enveloppe globale : toute réponse `data` devient
 * `{ data, message, statusCode }`. Si le handler renvoie déjà `{ data, message }`,
 * le `message` est respecté.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T>> {
    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((payload) => {
        const statusCode = res.statusCode ?? 200;
        if (
          payload &&
          typeof payload === 'object' &&
          'data' in (payload as Record<string, unknown>) &&
          'message' in (payload as Record<string, unknown>)
        ) {
          const p = payload as unknown as { data: T; message: string };
          return { data: p.data, message: p.message, statusCode };
        }
        return { data: payload as T, message: 'OK', statusCode };
      }),
    );
  }
}
