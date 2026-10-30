/**
 * A per-user budget of REAL provider calls, for the sections whose cache hits must stay free (the two profile-level count cards). It is
 * asked only when a call is about to be bought — i.e. from inside the cache's fetcher, which does not run on a hit — so a repeat visit,
 * a refresh inside the one-minute floor or a second user reading the same cached card never uses any of it.
 * In memory, per process: it resets on a restart, which only ever errs towards letting a user through.
 */

export class ProviderBudgetExceeded extends Error {
  constructor(message = 'Too many data requests. Please wait a few minutes and try again.') {
    super(message);
    this.name = 'ProviderBudgetExceeded';
    this.code = 'RATE_LIMITED';
  }
}

const used = new Map(); // `${userId}|${bucket}` -> timestamps of real calls

/**
 * Reserves `calls` real provider calls for the user, or throws ProviderBudgetExceeded (and reserves nothing).
 * @param {string} userId
 * @param {number} calls
 * @param {{ bucket?: string, windowMs: number, maxProviderCalls: number }} budget
 */
export function takeProviderCalls(userId, calls, { bucket = 'default', windowMs, maxProviderCalls }, now = Date.now()) {
  const key = `${userId || 'anonymous'}|${bucket}`;
  const recent = (used.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length + calls > maxProviderCalls) {
    used.set(key, recent);
    throw new ProviderBudgetExceeded();
  }
  for (let i = 0; i < calls; i += 1) recent.push(now);
  used.set(key, recent);
}

/** Tests only. */
export const __resetProviderBudgetForTests = () => used.clear();
