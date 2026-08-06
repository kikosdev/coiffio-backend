/**
 * Seed de dev : provisionne 2 tenants réels via `InternalService.provisionTenant` (Prompt 8),
 * réutilisé tel quel — ce script n'implémente aucune logique de provisioning, il l'appelle.
 * Boot complet de l'app HTTP (comme main.ts) pour pouvoir ensuite prouver un login RÉEL
 * (POST /auth/login) + une requête authentifiée par tenant, pas seulement une écriture DB.
 *
 * ⚠️ Cible IMPÉRATIVEMENT la base "multitenant" (jamais "salonos") — vérifié au démarrage,
 * le script refuse de continuer sinon.
 *
 * Idempotent : le tenantId est résolu par slug (réutilisé s'il existe déjà), puis passé à
 * `provisionTenant`, lui-même idempotent sur `tenantId` (Prompt 8) — rejouer ce script ne
 * crée jamais de doublon.
 *
 * Usage : ts-node -r tsconfig-paths/register src/scripts/seed-dev-tenants.ts
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import cookieParser from 'cookie-parser';
import * as dotenv from 'dotenv';
dotenv.config();

import { AppModule } from '../app.module';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { InternalService, ProvisionResult } from '../internal/internal.service';
import { runOutsideTenant } from '../common/tenant/tenant-context';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';

interface DevTenantDef {
  slug: string;
  name: string;
  region: string;
  owner: { name: string; email: string; phone: string; password: string };
}

// Pas de champ `country` sur ProvisionTenantDto ni sur le schéma Salon (vérifié dans le
// code) — timezone (Africa/Tunis) + region (Tunis / Nabeul) couvrent déjà la distinction
// géographique demandée par le prompt. Rien inventé plutôt qu'un champ fantôme non persisté.
const DEV_TENANTS: DevTenantDef[] = [
  {
    slug: 'alpha',
    name: 'Salon Alpha',
    region: 'Tunis',
    owner: { name: 'Alpha Owner', email: 'alpha@test.tn', phone: '+21620000001', password: 'Test1234!' },
  },
  {
    slug: 'beta',
    name: 'Salon Beta',
    region: 'Nabeul',
    owner: { name: 'Beta Owner', email: 'beta@test.tn', phone: '+21620000002', password: 'Test1234!' },
  },
];

async function main() {
  const uri = process.env.MONGO_URI ?? '';
  const dbName = uri.split('/').pop()?.split('?')[0];
  if (dbName !== 'multitenant') {
    throw new Error(
      `Refus de continuer : MONGO_URI pointe sur la base "${dbName}", pas "multitenant". ARRÊT — on ne touche pas à salonos.`,
    );
  }
  console.log(`[seed-dev-tenants] Cible confirmée : base "${dbName}".`);

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], rawBody: true });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const baseUrl = `http://127.0.0.1:${addr.port}/api`;

  const connection = app.get<Connection>(getConnectionToken());
  const salonModel = app.get<Model<SalonDocument>>(getModelToken(Salon.name));
  const internal = app.get(InternalService);

  const results: ProvisionResult[] = [];

  await runOutsideTenant('seed-dev-tenants script (local dev)', async () => {
    for (const def of DEV_TENANTS) {
      const existing = await salonModel.findOne({ slug: def.slug }).lean();
      const tenantId = existing ? (existing._id as Types.ObjectId).toString() : new Types.ObjectId().toString();

      const result = await internal.provisionTenant({
        tenantId,
        slug: def.slug,
        name: def.name,
        timezone: 'Africa/Tunis',
        currency: 'TND',
        region: def.region,
        owner: def.owner,
      });
      results.push(result);
      console.log(
        `[seed-dev-tenants] ${def.slug} -> tenantId=${result.tenantId} locationId=${result.locationId} ownerStaffId=${result.ownerStaffId} (${existing ? 'reutilise' : 'cree'})`,
      );
    }
  });

  // ── Preuves, relues depuis la base / réponse HTTP réelle ────────────────────────────────
  console.log('\n=== Preuves ===');

  for (const r of results) {
    const locs = await connection.collection('locations').find({ salonId: r.tenantId }).toArray();
    const primaryLocs = locs.filter((l) => l.isPrimary);
    console.log(`[${r.slug}] locations=${locs.length} isPrimary=${primaryLocs.length}`);

    const staff = await connection.collection('staffs').findOne({ _id: new Types.ObjectId(r.ownerStaffId) });
    console.log(`[${r.slug}] staff.salonId typeof=${typeof staff?.salonId} value=${staff?.salonId}`);
  }

  async function login(identifier: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    const text = await res.text();
    if (res.status !== 201) {
      throw new Error(`Login failed for ${identifier}: ${res.status} ${text}`);
    }
    const body = JSON.parse(text);
    return body.data.token as string;
  }

  const tokenA = await login(DEV_TENANTS[0].owner.email, DEV_TENANTS[0].owner.password);
  const meA = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${tokenA}` } });
  console.log(`[alpha] login OK, GET /auth/me -> ${meA.status}`);

  const tokenB = await login(DEV_TENANTS[1].owner.email, DEV_TENANTS[1].owner.password);
  const meB = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${tokenB}` } });
  console.log(`[beta] login OK, GET /auth/me -> ${meB.status}`);

  const teamARes = await fetch(`${baseUrl}/team`, { headers: { Authorization: `Bearer ${tokenA}` } });
  const teamABody = (await teamARes.json()) as { data: { name: string }[] };
  const namesA = teamABody.data.map((s) => s.name);
  console.log(`[alpha] GET /team -> ${teamARes.status}, staff visibles=${JSON.stringify(namesA)}`);
  const leaksB = namesA.includes('Beta Owner');
  console.log(`[isolation] "Beta Owner" visible dans /team d'Alpha ? ${leaksB} (doit etre false)`);

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed-dev-tenants] Fatal:', err);
  process.exit(1);
});
