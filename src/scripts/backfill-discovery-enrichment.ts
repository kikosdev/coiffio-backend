/**
 * Backfill idempotent : `priceRange`/`serviceTags` pour les salons créés avant
 * `SalonCatalogService` (SKILL_discovery_enrichment_sponsored, Prompt 2).
 *
 * Réutilise `SalonCatalogService.compute*`/`recompute*` (Prompt 1) — AUCUNE logique
 * d'agrégation dupliquée ici. Le dry-run appelle les méthodes `compute*` (lecture pure) ;
 * `--apply` appelle les méthodes `recompute*` (mêmes méthodes que le chemin live dans
 * `ServicesService`), et seulement pour les salons dont le résultat calculé diffère de ce
 * qui est stocké — un salon déjà à jour n'est jamais réécrit (idempotence prouvée par un
 * 2e passage à 0 écriture, pas seulement par un résultat final identique).
 *
 * `sponsored`/`sponsoredUntil` : jamais touchés ici (acte commercial explicite via le CP).
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/backfill-discovery-enrichment.ts             (dry-run, défaut)
 *   ts-node -r tsconfig-paths/register src/scripts/backfill-discovery-enrichment.ts --apply
 */
import 'reflect-metadata';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { formatInTimeZone } from 'date-fns-tz';
import * as dotenv from 'dotenv';
dotenv.config();

import { AppModule } from '../app.module';
import { runOutsideTenant } from '../common/tenant/tenant-context';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { SalonCatalogService, PriceRange } from '../salons/salon-catalog.service';

export interface ReportRow {
  salonId: string;
  slug: string;
  priceRangeBefore: PriceRange | null;
  priceRangeAfter: PriceRange | null;
  tagsBefore: string[];
  tagsAfter: string[];
  changed: boolean;
}

/** Même garde-fou que `migrate-create-memberships.ts` — ce backfill ne tourne que sur le
 * cluster dev tant qu'il n'a pas été prouvé sur `multitenant` puis explicitement autorisé. */
export function assertSafeTarget(uri: string): string | undefined {
  const dbName = uri.split('/').pop()?.split('?')[0];
  if (dbName === 'salonos') {
    throw new Error('Refus de continuer : MONGO_URI pointe sur "salonos" (prod). Ce backfill ne tourne que sur multitenant pour ce prompt.');
  }
  return dbName;
}

function priceRangeEqual(a: PriceRange | null | undefined, b: PriceRange | null): boolean {
  const left = a ?? null;
  if (left === null && b === null) return true;
  if (left === null || b === null) return false;
  return left.min === b.min && left.max === b.max;
}

function tagsEqual(a: string[] | undefined, b: string[]): boolean {
  const left = a ?? [];
  return left.length === b.length && left.every((v, i) => v === b[i]);
}

export async function runBackfill(app: INestApplicationContext, apply: boolean): Promise<ReportRow[]> {
  const SalonModel = app.get<Model<SalonDocument>>(getModelToken(Salon.name));
  const catalog = app.get(SalonCatalogService);

  return runOutsideTenant('migration:discovery-enrichment', async () => {
    const salons = await SalonModel.find({}).select('_id slug priceRange serviceTags').lean();
    const report: ReportRow[] = [];

    for (const salon of salons) {
      const salonId = salon._id.toString();
      const [priceRangeAfter, tagsAfter] = await Promise.all([
        catalog.computePriceRange(salonId),
        catalog.computeTags(salonId),
      ]);

      const priceRangeBefore = salon.priceRange ?? null;
      const tagsBefore = salon.serviceTags ?? [];
      const changed = !priceRangeEqual(priceRangeBefore, priceRangeAfter) || !tagsEqual(tagsBefore, tagsAfter);

      if (apply && changed) {
        await Promise.all([catalog.recomputePriceRange(salonId), catalog.recomputeTags(salonId)]);
      }

      report.push({
        salonId,
        slug: salon.slug ?? '',
        priceRangeBefore,
        priceRangeAfter,
        tagsBefore,
        tagsAfter,
        changed,
      });
    }

    return report;
  });
}

function fmtPriceRange(pr: PriceRange | null): string {
  return pr ? `${pr.min}..${pr.max}` : '—';
}

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI ?? '';
  const dbName = assertSafeTarget(uri);
  const now = formatInTimeZone(new Date(), 'Africa/Tunis', "yyyy-MM-dd HH:mm:ss 'GMT'XXX");
  console.log(`[backfill-discovery-enrichment] ${now} — cible "${dbName}". Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const report = await runBackfill(app, apply);

  console.log('\n=== Rapport (avant -> après) ===');
  console.log(
    'slug'.padEnd(16),
    'priceRange avant'.padEnd(20),
    'priceRange après'.padEnd(20),
    'tags avant'.padEnd(28),
    'tags après'.padEnd(28),
    'action',
  );
  for (const r of report) {
    console.log(
      (r.slug || r.salonId).padEnd(16),
      fmtPriceRange(r.priceRangeBefore).padEnd(20),
      fmtPriceRange(r.priceRangeAfter).padEnd(20),
      (r.tagsBefore.join(',') || '—').padEnd(28),
      (r.tagsAfter.join(',') || '—').padEnd(28),
      r.changed ? (apply ? 'écrit' : '[DRY-RUN] écrirait') : 'unchanged',
    );
  }

  const summary = {
    salonsProcessed: report.length,
    priceRangesSet: report.filter((r) => r.priceRangeAfter !== null).length,
    priceRangesUnset: report.filter((r) => r.priceRangeAfter === null).length,
    tagsSet: report.filter((r) => r.tagsAfter.length > 0).length,
    unchanged: report.filter((r) => !r.changed).length,
  };
  console.log('\n=== Résumé ===');
  console.log(JSON.stringify(summary, null, 2));

  if (!apply) {
    const wouldChange = report.filter((r) => r.changed).length;
    console.log(`\n[DRY-RUN] Rien écrit. ${wouldChange} salon(s) seraient modifiés. Relancer avec --apply pour écrire.`);
  }

  await app.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill-discovery-enrichment] Fatal:', err);
    process.exit(1);
  });
}
