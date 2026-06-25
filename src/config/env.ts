/**
 * Typage + validation des variables d'environnement (Sprint 0 — convention #1/#3).
 * Source unique de vérité pour la config ; lève une erreur explicite si une variable manque.
 */

export interface AppEnv {
  MONGO_URI: string;
  JWT_SECRET: string;
  JWT_EXPIRES: string;
  FRONTEND_ORIGIN: string;
  PORT: number;
}

const REQUIRED: (keyof Omit<AppEnv, 'PORT'>)[] = [
  'MONGO_URI',
  'JWT_SECRET',
  'JWT_EXPIRES',
  'FRONTEND_ORIGIN',
];

let cached: AppEnv | null = null;

export function JwtStrategy(): AppEnv {
  if (cached) return cached;
console.log('check env ', process.env)
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k]!.trim() === '');
  console.log('check misding ', missing)
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Copy .env.example to .env and fill them in.`,
    );
  }

  const portRaw = process.env.PORT ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${portRaw}" (expected a positive integer).`);
  }

  cached = {
    MONGO_URI: process.env.MONGO_URI!,
    JWT_SECRET: process.env.JWT_SECRET!,
    JWT_EXPIRES: process.env.JWT_EXPIRES!,
    FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN!,
    PORT: port,
  };
  return cached;
}
