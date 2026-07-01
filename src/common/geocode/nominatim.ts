/**
 * Géocodage d'adresse via Nominatim (OpenStreetMap) — gratuit, sans clé.
 * Politique OSM : 1 req/s max + User-Agent obligatoire (sinon ban IP).
 */
export interface GeocodeResult {
  lat: number;
  lng: number;
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'coiffio-backend/1.0 (contact: ops@coiffio.app)';

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  if (!address?.trim()) return null;

  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;

  const results = (await res.json()) as Array<{ lat: string; lon: string }>;
  const first = results[0];
  if (!first) return null;

  return { lat: parseFloat(first.lat), lng: parseFloat(first.lon) };
}
