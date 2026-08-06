/**
 * Stand-in TEMPORAIRE pour Redis (aucune instance disponible dans cet environnement —
 * décision explicite prise avec l'utilisateur, Sprint 1 v2 Prompt 5). Fonctionnellement
 * équivalent pour un TTL de quelques minutes sur un seul process : ne survit pas à un
 * restart, ne se partage pas entre plusieurs instances. À remplacer par un vrai client
 * Redis (ioredis / @nestjs/cache-manager) dès qu'une instance est provisionnée — l'API
 * (get/set/du TTL) est volontairement calquée sur ce que ferait un cache Redis, pour que
 * ce remplacement soit une substitution mécanique, pas une réécriture des appelants.
 */
export class MemoryCache {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async getOrSet<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await compute();
    this.set(key, value, ttlMs);
    return value;
  }

  delete(key: string): void {
    this.store.delete(key);
  }
}
