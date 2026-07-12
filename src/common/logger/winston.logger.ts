import { createLogger, format, transports } from 'winston';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Logger Winston partagé — utilisé par le HttpLoggerMiddleware pour tracer
 * chaque appel API (méthode, url, statut, durée) et par le Logger Nest global
 * (bootstrap) via `app.useLogger`.
 */
export const winstonLogger = createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: isProd
    ? format.combine(format.timestamp(), format.json())
    : format.combine(
        format.timestamp({ format: 'HH:mm:ss' }),
        format.colorize(),
        format.printf(({ timestamp, level, message, context }) => {
          const ctx = context ? ` [${context}]` : '';
          return `${timestamp} ${level}${ctx} ${message}`;
        }),
      ),
  transports: [new transports.Console()],
});
