import { LoggerService } from '@nestjs/common';
import { winstonLogger } from './winston.logger';

/**
 * Pont entre le LoggerService de Nest (logs de bootstrap, `new Logger(ctx).log(...)`
 * utilisés dans les modules) et Winston, pour que tous les logs — bootstrap
 * comme requêtes HTTP — passent par le même format/transport.
 */
export class NestWinstonLogger implements LoggerService {
  log(message: unknown, context?: string) {
    winstonLogger.info(this.stringify(message), { context });
  }

  error(message: unknown, trace?: string, context?: string) {
    winstonLogger.error(this.stringify(message), { context });
    if (trace) winstonLogger.error(trace, { context });
  }

  warn(message: unknown, context?: string) {
    winstonLogger.warn(this.stringify(message), { context });
  }

  debug(message: unknown, context?: string) {
    winstonLogger.debug(this.stringify(message), { context });
  }

  verbose(message: unknown, context?: string) {
    winstonLogger.verbose(this.stringify(message), { context });
  }

  private stringify(message: unknown): string {
    return typeof message === 'string' ? message : JSON.stringify(message);
  }
}
