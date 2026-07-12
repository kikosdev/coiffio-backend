import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { winstonLogger } from '../logger/winston.logger';

/**
 * Trace chaque appel API (méthode, url, statut, durée, IP) dès la réponse
 * envoyée — permet de suivre la consommation des routes en dev comme en prod.
 */
@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const { method, originalUrl, ip } = req;

    res.on('finish', () => {
      const duration = Date.now() - start;
      const { statusCode } = res;
      const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
      winstonLogger.log(
        level,
        `${method} ${originalUrl} ${statusCode} - ${duration}ms - ${ip}`,
        { context: 'HTTP' },
      );
    });

    next();
  }
}
