const TUNIS_TZ = 'Africa/Tunis';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Jour (0=dim) + heure "HH:mm" courants en Africa/Tunis, sans dépendance
 * supplémentaire (date-fns-tz non installé côté backend — Intl suffit).
 */
export function nowInSalonTimezone(): { weekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TUNIS_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';

  return { weekday: WEEKDAYS.indexOf(weekdayStr), hhmm: `${hour}:${minute}` };
}

/**
 * V1 simple (SD-2, SKILL_client_search_dynamic) : le staff est "available" s'il a un
 * shift aujourd'hui dans son planning hebdo. Ignore les breaks — la vraie disponibilité
 * (slots libres temps réel) dépend du moteur de réservation, déféré avec le per-request scope.
 */
export function computeStaffOnShiftToday(staff: { week?: { day: number; start: string; end: string }[] }): boolean {
  if (!staff.week?.length) return false;
  const { weekday } = nowInSalonTimezone();
  return staff.week.some((shift) => shift.day === weekday);
}

export function computeSalonIsOpen(salon: {
  businessHours?: { day: number; isOpen: boolean; start: string; end: string }[];
}): boolean | null {
  if (!salon.businessHours?.length) return null;

  const { weekday, hhmm } = nowInSalonTimezone();
  const today = salon.businessHours.find((h) => h.day === weekday);
  if (!today || !today.isOpen) return false;

  return hhmm >= today.start && hhmm <= today.end;
}
