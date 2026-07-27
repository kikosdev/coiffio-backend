/**
 * Migration idempotente : backfill `ClientProfile` + `clients.profileId` (Sprint 1 v2,
 * Prompt 4). Groupe les `clients` par téléphone NORMALISÉ (via `normalizePhone`, pas le
 * `phone` brut — deux formats différents peuvent être la même identité).
 *
 * Politique conservatrice (point durci #5) :
 *   - Téléphone non normalisable (voir phone-normalization.util.ts)
 *     → listé dans `unnormalizable`, AUCUN traitement.
 *   - Téléphone normalisé présent sur PLUSIEURS documents `clients` (même tenant ou
 *     tenants différents) → CONFLIT. Listé dans `conflicts`, AUCUN des documents du
 *     groupe n'est traité automatiquement — jamais de fusion auto, même si le contenu
 *     semble identique.
 *   - Téléphone normalisé présent sur UN SEUL document → traité : ClientProfile
 *     find-or-create par téléphone normalisé, `clients.profileId` renseigné,
 *     `ClientProfile.tenantIds` mis à jour.
 *
 * ⚠️ NE PAS lancer --apply avant : (1) la migration de type salonId→String en prod,
 * (2) le nettoyage manuel des doublons de dev que vous avez identifiés (Test USER,
 * Testuser Test, Skander Amor). `benzarti emna` (le seul cas métier réel connu à ce
 * jour) doit apparaître dans `conflicts` — c'est le comportement attendu, pas un bug.
 *
 * Usage :
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-backfill-client-profiles.ts             (dry-run, défaut)
 *   ts-node -r tsconfig-paths/register src/scripts/migrate-backfill-client-profiles.ts --apply
 *
 * Idempotent : ne retraite jamais un `clients` document qui a déjà `profileId`.
 */

import 'reflect-metadata';
import { Collection, Db, MongoClient, ObjectId } from 'mongodb';
import * as dotenv from 'dotenv';
dotenv.config();

import { normalizePhone } from '../identity/phone-normalization.util';

interface ClientDoc {
  _id: ObjectId;
  salonId: string;
  phone: string;
  name?: string;
  email?: string;
  userId?: ObjectId | null;
  profileId?: string;
}

interface ConflictRow {
  normalizedPhone: string;
  docs: Array<{ _id: string; salonId: string; name?: string; email?: string; userId: string | null; rawPhone: string }>;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in environment.');

  const client = new MongoClient(uri);
  await client.connect();
  const db: Db = client.db();
  console.log(`[migrate-backfill-client-profiles] Connected. Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const clients: Collection<ClientDoc> = db.collection('clients');
  const profiles = db.collection('clientprofiles');

  // Seuls les documents pas encore rattachés sont candidats — idempotence.
  const candidates = await clients.find({ profileId: { $exists: false } }).toArray();
  console.log(`[migrate-backfill-client-profiles] ${candidates.length} client(s) sans profileId (sur un total à vérifier séparément).`);

  const byNormalizedPhone = new Map<string, ClientDoc[]>();
  const unnormalizable: ClientDoc[] = [];

  for (const doc of candidates) {
    const normalized = normalizePhone(doc.phone ?? '');
    if (!normalized) {
      unnormalizable.push(doc);
      continue;
    }
    const bucket = byNormalizedPhone.get(normalized) ?? [];
    bucket.push(doc);
    byNormalizedPhone.set(normalized, bucket);
  }

  const conflicts: ConflictRow[] = [];
  const toProcess: Array<{ normalizedPhone: string; doc: ClientDoc }> = [];

  for (const [normalizedPhone, docs] of byNormalizedPhone) {
    if (docs.length > 1) {
      conflicts.push({
        normalizedPhone,
        docs: docs.map((d) => ({
          _id: d._id.toString(),
          salonId: d.salonId,
          name: d.name,
          email: d.email,
          userId: d.userId ? d.userId.toString() : null,
          rawPhone: d.phone,
        })),
      });
      continue;
    }
    toProcess.push({ normalizedPhone, doc: docs[0] });
  }

  console.log(`\n=== Rapport ===`);
  console.log(`Candidats sans profileId       : ${candidates.length}`);
  console.log(`Non normalisables (skip)       : ${unnormalizable.length}`);
  console.log(`Conflits (téléphone collision) : ${conflicts.length}`);
  console.log(`Traitables (1 doc / téléphone) : ${toProcess.length}`);

  if (unnormalizable.length > 0) {
    console.log(`\n--- Non normalisables ---`);
    for (const d of unnormalizable) {
      console.log(`  _id=${d._id} salonId=${d.salonId} phone="${d.phone}" name="${d.name ?? ''}"`);
    }
  }

  if (conflicts.length > 0) {
    console.log(`\n--- Conflits (revue manuelle requise, aucune fusion auto) ---`);
    for (const c of conflicts) {
      console.log(`\n  téléphone normalisé: ${c.normalizedPhone}`);
      for (const d of c.docs) {
        console.log(`    _id=${d._id} salonId=${d.salonId} name="${d.name ?? ''}" email="${d.email ?? ''}" userId=${d.userId} rawPhone="${d.rawPhone}"`);
      }
    }
  }

  let profilesCreated = 0;
  let clientsLinked = 0;

  if (apply) {
    for (const { normalizedPhone, doc } of toProcess) {
      let profile = await profiles.findOne({ phone: normalizedPhone });
      if (!profile) {
        const insertResult = await profiles.insertOne({
          _id: new ObjectId(),
          phone: normalizedPhone,
          name: doc.name ?? '',
          email: doc.email ?? '',
          userId: doc.userId ?? undefined,
          tenantIds: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        profile = { _id: insertResult.insertedId };
        profilesCreated++;
      }

      await clients.updateOne({ _id: doc._id }, { $set: { profileId: profile._id.toString() } });
      await profiles.updateOne({ _id: profile._id }, { $addToSet: { tenantIds: doc.salonId } });
      clientsLinked++;
    }
  }

  console.log(`\n${apply ? 'Résultat' : '[DRY-RUN] Résultat projeté'} : profilesCreated=${profilesCreated} (estimation: ${toProcess.length} au maximum) clientsLinked=${apply ? clientsLinked : toProcess.length}`);

  if (!apply) {
    console.log('\n[DRY-RUN] Rien écrit. Relancer avec --apply pour traiter les cas sans collision.');
    console.log(`[DRY-RUN] Les ${conflicts.length} conflit(s) et ${unnormalizable.length} non-normalisable(s) ne seront JAMAIS traités automatiquement, même en --apply.`);
  }

  await client.close();
}

main().catch((err) => {
  console.error('[migrate-backfill-client-profiles] Fatal:', err);
  process.exit(1);
});
