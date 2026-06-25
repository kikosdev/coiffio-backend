/**
 * Helpers purs du moteur de disponibilité (constitution — « the hard contract »).
 * Toute la logique temporelle est en minutes-depuis-minuit ; les Date sont construites
 * en UTC à partir de la date "YYYY-MM-DD" et de "HH:mm" pour rester déterministe.
 */

export const SLOT_STEP_MIN = 30;

export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function minToHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Date UTC pour `date` (YYYY-MM-DD) à `min` minutes après minuit. */
export function dateAtMin(date: string, min: number): Date {
  return new Date(`${date}T${minToHhmm(min)}:00.000Z`);
}

/** Jour de la semaine (0=dim … 6=sam) pour une date YYYY-MM-DD (en UTC). */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Nom du jour de la semaine pour une date YYYY-MM-DD (en UTC). */
export function weekdayName(date: string): string {
  return WEEKDAY_NAMES[weekdayOf(date)];
}

/** Date YYYY-MM-DD aujourd'hui (UTC). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Date YYYY-MM-DD décalée de `n` jours (peut être négatif). */
export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface Interval {
  start: number; // minutes
  end: number;
}

/** Chevauchement strict de deux intervalles [aStart,aEnd) et [bStart,bEnd). */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export interface WorkingWindow {
  start: number; // minutes
  end: number;
  breaks: Interval[];
}

/**
 * Calcule la fenêtre de travail effective d'un jour : la base hebdo, modifiée par
 * l'override éventuel (off/leave → aucune fenêtre ; custom → remplace start/end).
 * Renvoie null si le stylist ne travaille pas ce jour-là.
 */
export function effectiveWindow(
  weekly: { day: number; start: string; end: string; breaks: { start: string; end: string }[] }[],
  overrides: { date: string; type: 'off' | 'leave' | 'custom'; start?: string; end?: string }[],
  date: string,
): WorkingWindow | null {
  const override = overrides.find((o) => o.date === date);
  if (override && (override.type === 'off' || override.type === 'leave')) return null;

  const base = weekly.find((w) => w.day === weekdayOf(date));

  if (override && override.type === 'custom') {
    if (!override.start || !override.end) return null;
    return {
      start: hhmmToMin(override.start),
      end: hhmmToMin(override.end),
      breaks: (base?.breaks ?? []).map((b) => ({ start: hhmmToMin(b.start), end: hhmmToMin(b.end) })),
    };
  }

  if (!base) return null;
  return {
    start: hhmmToMin(base.start),
    end: hhmmToMin(base.end),
    breaks: base.breaks.map((b) => ({ start: hhmmToMin(b.start), end: hhmmToMin(b.end) })),
  };
}

/**
 * Génère les créneaux de départ valides (en minutes) pour une fenêtre donnée :
 * pas de 30 min, tiennent dans la fenêtre, ne chevauchent ni une pause ni un busy.
 * `busy` = blocs occupés (appointments) exprimés en minutes-depuis-minuit.
 */
export function computeSlots(window: WorkingWindow, need: number, busy: Interval[]): number[] {
  const slots: number[] = [];
  for (let t = window.start; t + need <= window.end; t += SLOT_STEP_MIN) {
    const end = t + need;
    const hitsBreak = window.breaks.some((b) => overlaps(t, end, b.start, b.end));
    const hitsBusy = busy.some((b) => overlaps(t, end, b.start, b.end));
    if (!hitsBreak && !hitsBusy) slots.push(t);
  }
  return slots;
}
