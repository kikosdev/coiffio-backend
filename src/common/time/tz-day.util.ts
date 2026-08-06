import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';

export const TUNIS_TZ = 'Africa/Tunis';

/**
 * Bornes de jour + libellés calendaires en heure réelle Africa/Tunis (Prompt 6, Partie C) —
 * pour les rapports/plages qui bucketisent des Instants déjà corrects (Payment.date,
 * Sale.date, Expense.date, "now"). Ne PAS utiliser sur le domaine booking/schedule
 * (Appointment.start/end, availability.util.ts) : ce domaine construit ses Date en traitant
 * "YYYY-MM-DD"+"HH:mm" comme de l'UTC littéral (déterminisme du moteur de slots), une
 * convention distincte et volontairement non touchée ici — cf. décision Prompt 6.
 */

/** Début de journée (00:00:00.000) réel Africa/Tunis pour `date` (YYYY-MM-DD), en Instant UTC. */
export function startOfDayInTz(date: string, timeZone = TUNIS_TZ): Date {
  return fromZonedTime(`${date}T00:00:00.000`, timeZone);
}

/** Fin de journée (23:59:59.999) réelle Africa/Tunis pour `date` (YYYY-MM-DD), en Instant UTC. */
export function endOfDayInTz(date: string, timeZone = TUNIS_TZ): Date {
  return fromZonedTime(`${date}T23:59:59.999`, timeZone);
}

/** "YYYY-MM-DD" pour `instant`, lu en heure locale Africa/Tunis (pas UTC). */
export function isoDateInTz(instant: Date, timeZone = TUNIS_TZ): string {
  return formatInTimeZone(instant, timeZone, 'yyyy-MM-dd');
}

/** "YYYY-MM" pour `instant`, lu en heure locale Africa/Tunis. */
export function isoMonthInTz(instant: Date, timeZone = TUNIS_TZ): string {
  return formatInTimeZone(instant, timeZone, 'yyyy-MM');
}

/** Date calendaire (YYYY-MM-DD) "aujourd'hui" en heure réelle Africa/Tunis — pas UTC. */
export function todayIsoInTz(timeZone = TUNIS_TZ): string {
  return isoDateInTz(new Date(), timeZone);
}

/** Décale une date calendaire "YYYY-MM-DD" de `days` jours (arithmétique pure, sans TZ). */
export function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
