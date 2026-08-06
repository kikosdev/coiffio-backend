/**
 * Migration Sprint 2 v2, Prompt 1 — projection un-pour-un `staffs`/`clients` → `Membership`.
 *
 * L'audit préalable (lecture seule, `multitenant` ET `salonos`) a confirmé 0 cas emmêlé :
 * aucun user déjà multi-tenant, aucun user client ET staff simultanément, aucun doublon
 * email staff/client. Cette migration ne fait donc AUCUNE fusion/résolution de conflit —
 * juste une projection directe, avec un filet d'idempotence (skip si un Membership
 * (userId, tenantId) existe déjà).
 *
 * PHASE 1 — staffs → Membership kind='staff', role = staffs.role (JAMAIS users.role).
 * PHASE 2 — clients avec userId → Membership kind='client', locationIds = toutes les
 *           locations actives du tenant, defaultLocationId = la primaire.
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-create-memberships.ts             (dry-run, défaut)
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-create-memberships.ts --apply
 *
 * Idempotent : un 2e passage ne crée rien (index unique {userId,tenantId} + skip explicite
 * avant écriture). `runOutsideTenant('migration:memberships', ...)` — `staffs`/`clients`/
 * `locations` sont scopés, lus ici sans TenantContext réel (script système).
 */
import 'reflect-metadata';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

import { AppModule } from '../app.module';
import { runOutsideTenant } from '../common/tenant/tenant-context';
import { Membership, MembershipDocument, MembershipRole } from '../identity/schemas/membership.schema';
import { LocationService } from '../locations/location.service';

export interface ReportRow {
  phase: 'staff' | 'client';
  tenantId: string;
  userId: string;
  refId: string; // staffId ou clientId
  role: string;
  action: 'created' | 'skipped';
  reason?: string;
}

/**
 * Garde-fou prod, extrait en fonction pure (testable sans boot Nest ni subprocess) :
 * un test peut prouver ce refus directement contre une URI en mémoire nommée "salonos",
 * sans jamais toucher au vrai cluster.
 */
export function assertSafeTarget(uri: string): string | undefined {
  const dbName = uri.split('/').pop()?.split('?')[0];
  if (dbName === 'salonos') {
    throw new Error('Refus de continuer : MONGO_URI pointe sur "salonos" (prod). Cette migration ne tourne que sur multitenant pour ce prompt.');
  }
  return dbName;
}

/**
 * Cœur de la migration, extrait de `main()` pour être appelable en-process par les tests
 * (via `bootApp()`, la même app Nest déjà utilisée par le reste de la suite) — élimine tout
 * besoin de spawn un subprocess séparé contre le même `mongodb-memory-server`, source d'une
 * flakiness de connexion non-déterministe (côté OS Windows) diagnostiquée en Prompt 7.
 */
export async function runMigration(app: INestApplicationContext, apply: boolean): Promise<ReportRow[]> {
  const connection = app.get<Connection>(getConnectionToken());
  const MembershipModel = app.get<Model<MembershipDocument>>(getModelToken(Membership.name));
  const locations = app.get(LocationService);

  const report: ReportRow[] = [];

  await runOutsideTenant('migration:memberships', async () => {
    // ── PHASE 1 — staffs → Membership kind='staff' ─────────────────────────
    const staffs = await connection.collection('staffs').find({}).toArray();
    for (const staff of staffs) {
      const tenantId: string | undefined = staff.salonId;
      const userId: Types.ObjectId | undefined = staff.userId;
      if (!tenantId || !userId) {
        report.push({ phase: 'staff', tenantId: tenantId ?? '', userId: userId?.toString() ?? '', refId: staff._id.toString(), role: staff.role ?? '', action: 'skipped', reason: 'missing salonId/userId' });
        continue;
      }

      const existing = await MembershipModel.findOne({ userId, tenantId }).exec();
      if (existing) {
        report.push({ phase: 'staff', tenantId, userId: userId.toString(), refId: staff._id.toString(), role: staff.role, action: 'skipped', reason: 'membership already exists' });
        continue;
      }

      if (apply) {
        await MembershipModel.create({
          userId,
          tenantId,
          kind: 'staff',
          staffId: staff._id,
          role: staff.role as MembershipRole, // staffs.role, JAMAIS users.role — autoritaire
          locationIds: staff.locationIds ?? [],
          defaultLocationId: staff.defaultLocationId,
          status: staff.isActive ? 'active' : 'suspended',
        });
      }
      report.push({ phase: 'staff', tenantId, userId: userId.toString(), refId: staff._id.toString(), role: staff.role, action: 'created' });
    }

    // ── PHASE 2 — clients avec userId → Membership kind='client' ───────────
    const clients = await connection.collection('clients').find({ userId: { $ne: null } }).toArray();
    for (const clientDoc of clients) {
      const tenantId: string = clientDoc.salonId;
      const userId: Types.ObjectId = clientDoc.userId;

      const existing = await MembershipModel.findOne({ userId, tenantId }).exec();
      if (existing) {
        report.push({ phase: 'client', tenantId, userId: userId.toString(), refId: clientDoc._id.toString(), role: 'client', action: 'skipped', reason: 'membership already exists' });
        continue;
      }

      const tenantLocations = await locations.findAllForTenant({ salonId: tenantId });
      const locationIds = tenantLocations.map((l) => (l._id as Types.ObjectId).toString());
      const primary = tenantLocations.find((l) => l.isPrimary) ?? tenantLocations[0];

      if (apply) {
        await MembershipModel.create({
          userId,
          tenantId,
          kind: 'client',
          clientId: clientDoc._id,
          role: 'client',
          locationIds,
          defaultLocationId: primary ? (primary._id as Types.ObjectId).toString() : undefined,
          status: 'active',
        });
      }
      report.push({ phase: 'client', tenantId, userId: userId.toString(), refId: clientDoc._id.toString(), role: 'client', action: 'created' });
    }
  });

  return report;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI ?? '';
  const dbName = assertSafeTarget(uri);
  console.log(`[migrate-create-memberships] Cible confirmée : base "${dbName}". Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const report = await runMigration(app, apply);

  console.log('\n=== Rapport ===');
  console.log('phase'.padEnd(8), 'tenantId'.padEnd(26), 'userId'.padEnd(26), 'role'.padEnd(10), 'action'.padEnd(9), 'reason');
  for (const r of report) {
    console.log(r.phase.padEnd(8), r.tenantId.padEnd(26), r.userId.padEnd(26), r.role.padEnd(10), r.action.padEnd(9), r.reason ?? '');
  }

  const summary = (phase: 'staff' | 'client') => ({
    created: report.filter((r) => r.phase === phase && r.action === 'created').length,
    skipped: report.filter((r) => r.phase === phase && r.action === 'skipped').length,
  });
  console.log(`\nstaff  -> ${JSON.stringify(summary('staff'))}`);
  console.log(`client -> ${JSON.stringify(summary('client'))}`);
  if (!apply) console.log('\n[DRY-RUN] Rien écrit. Relancer avec --apply pour créer les memberships.');

  await app.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate-create-memberships] Fatal:', err);
    process.exit(1);
  });
}
