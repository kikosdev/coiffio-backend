/**
 * Migration : déplace les users avec role ∈ ['owner','supervisor','staff'] vers la
 * collection `staffs`, en PRÉSERVANT les _id pour ne pas orpheliner les RDV/plannings.
 *
 * Usage : npx ts-node -r tsconfig-paths/register scripts/migrate-users-to-staffs.ts
 *
 * Idempotent : $setOnInsert + upsert → aucun écrasement si rejoué.
 * Les _id existants dans staffs sont ignorés (skipped count).
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AppModule } from '../src/app.module';

const TARGET_SALON_ID = '6a2c12cfa8b5cf60d1df98ab';
const LEGACY_STAFF_ROLES = ['owner', 'supervisor', 'staff'];

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const conn = app.get<Connection>(getConnectionToken());

  const salonsCol = conn.collection('salons');
  const usersCol = conn.collection('users');
  const staffsCol = conn.collection('staffs');

  // 1. Vérifie que le salon cible existe.
  const salon = await salonsCol.findOne({ _id: new Types.ObjectId(TARGET_SALON_ID) });
  if (!salon) {
    throw new Error(
      `Salon ${TARGET_SALON_ID} introuvable — exécutez le seed d'abord (npm run seed).`,
    );
  }

  // 2. Sélectionne les users avec un rôle staff legacy.
  const candidates = await usersCol
    .find({ role: { $in: LEGACY_STAFF_ROLES } })
    .toArray();
  console.log(`Candidats trouvés dans 'users' : ${candidates.length}`);

  // 3. Upsert dans 'staffs' en réutilisant le même _id ($setOnInsert = idempotent).
  let copied = 0;
  let skipped = 0;
  for (const user of candidates) {
    const result = await staffsCol.updateOne(
      { _id: user._id },
      {
        $setOnInsert: {
          _id: user._id,
          name: user.name ?? '',
          role: user.role,
          phone: user.phone ?? '',
          email: user.email ?? '',
          color: user.color ?? '#B89968',
          isActive: user.isActive ?? true,
          passwordHash: user.passwordHash ?? null,
          salonId: TARGET_SALON_ID,
          week: user.week ?? [],
          publicProfile: { visible: true, order: 0 },
          createdAt: user.createdAt ?? new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount > 0) {
      copied++;
    } else {
      skipped++;
    }
  }

  // 4. Après copie réussie : supprime ces docs de 'users'.
  //    Ne touche PAS les role='client'.
  const ids = candidates.map((u) => u._id);
  const { deletedCount } = await usersCol.deleteMany({
    _id: { $in: ids },
    role: { $in: LEGACY_STAFF_ROLES },
  });

  // 5. Récap.
  const recap = {
    salonId: TARGET_SALON_ID,
    candidatesFound: candidates.length,
    copied,
    skipped,
    deletedFromUsers: deletedCount,
  };
  console.log('Migration terminée :', JSON.stringify(recap, null, 2));

  await app.close();
}

main().catch((err: Error) => {
  console.error('Migration échouée :', err.message);
  process.exit(1);
});
