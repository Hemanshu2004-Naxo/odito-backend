import { PLANS } from './plans.js';

/**
 * Social Media AI - monthly calendar allowance per subscription plan.
 *
 * Where the number comes from (first decided source wins, per account):
 *   1. the plan's own entitlement:  PLANS[plan].socialAi.calendarPostsPerMonth  (config/plans.js), or - while that is still `null`,
 *      i.e. not decided - the deployment setting  SOCIAL_AI_<PLAN>_CALENDAR_POSTS_PER_MONTH   (e.g. SOCIAL_AI_PRO_CALENDAR_POSTS_PER_MONTH)
 *   2. an account with NO plan (never subscribed / an unknown plan id):  SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH
 *   3. the platform-wide setting  SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH  (the older, single number for everybody)
 * A value is a whole number of posts (0 = not included), or the word `unlimited` - an explicit, deliberate choice.
 *
 * What "nothing decided" means: in production the feature is REFUSED (fail closed) - missing configuration is never read as
 * "unlimited". Outside production it stays unlimited so local development and tests work without setup. Invalid or contradictory values
 * stop the server at startup (assertSocialAiConfig), because a typo must not silently turn into "no limit".
 *
 * Every function reads the environment when it is CALLED (never at import), so tests and a restart pick changes up without reloading modules.
 */

export const UNLIMITED = 'unlimited';
export const NO_PLAN_ENV = 'SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH';
export const PLATFORM_USER_ENV = 'SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH';
export const PLATFORM_PROJECT_ENV = 'SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH';
export const IN_FLIGHT_ENV = 'SOCIAL_AI_CALENDAR_QUOTA_MAX_IN_FLIGHT_PER_USER';
const COST_ENVS = ['SOCIAL_AI_COST_USD_PER_MTOK_INPUT', 'SOCIAL_AI_COST_USD_PER_MTOK_OUTPUT'];
/** A sanity ceiling: a typo such as an extra zero or a pasted id is refused, not accepted as a (practically unlimited) number. */
const MAX_ALLOWANCE = 100_000;

export const planAllowanceEnvVar = (planId) => `SOCIAL_AI_${String(planId).toUpperCase()}_CALENDAR_POSTS_PER_MONTH`;
export const isProduction = (env = process.env) => env.NODE_ENV === 'production';

export class SocialAiConfigError extends Error {
  constructor(problems) {
    super(`Invalid Social AI quota configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'SocialAiConfigError';
    this.code = 'SOCIAL_AI_CONFIG_INVALID';
    this.problems = problems;
  }
}

/**
 * @returns {{ ok: true, value: number | 'unlimited' | undefined } | { ok: false, reason: string }}  undefined = not set
 */
export function parseAllowance(raw, { min = 0 } = {}) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < min || raw > MAX_ALLOWANCE) return { ok: false, reason: `must be a whole number from ${min} to ${MAX_ALLOWANCE}, or "${UNLIMITED}"` };
    return { ok: true, value: raw };
  }
  const text = String(raw).trim();
  if (text === '') return { ok: true, value: undefined };
  if (text.toLowerCase() === UNLIMITED) return { ok: true, value: UNLIMITED };
  if (!/^\d{1,9}$/.test(text)) return { ok: false, reason: `"${text.slice(0, 24)}" is not a whole number of posts (or "${UNLIMITED}")` };
  const n = Number(text);
  if (n < min || n > MAX_ALLOWANCE) return { ok: false, reason: `${n} is outside ${min}..${MAX_ALLOWANCE}` };
  return { ok: true, value: n };
}

const decided = (value) => value !== undefined;

/** What the plan file itself says (null / undefined = not decided). */
function planConstant(planId) {
  const raw = PLANS[planId]?.socialAi?.calendarPostsPerMonth;
  return raw === null || raw === undefined ? { ok: true, value: undefined } : parseAllowance(raw);
}

/**
 * The allowance that applies to an account on `planId` (null / unknown = no plan).
 * @returns {{ state: 'limited' | 'unlimited' | 'unconfigured' | 'invalid', posts: number | null, source: 'plan' | 'env' | 'platform' | 'none', planId: string | null, reason?: string }}
 */
export function getSocialAiAllowance(planId, env = process.env) {
  const known = planId && Object.prototype.hasOwnProperty.call(PLANS, planId) ? planId : null;
  const of = (value, source) => (value === UNLIMITED ? { state: 'unlimited', posts: null, source, planId: known } : { state: 'limited', posts: value, source, planId: known });

  if (known) {
    const fromFile = planConstant(known);
    const fromEnv = parseAllowance(env[planAllowanceEnvVar(known)]);
    if (!fromFile.ok || !fromEnv.ok) return { state: 'invalid', posts: null, source: 'none', planId: known, reason: `${known}: ${(fromFile.ok ? fromEnv : fromFile).reason}` };
    if (decided(fromFile.value) && decided(fromEnv.value) && fromFile.value !== fromEnv.value) return { state: 'invalid', posts: null, source: 'none', planId: known, reason: `${known}: plans.js says ${fromFile.value} but ${planAllowanceEnvVar(known)} says ${fromEnv.value}` };
    if (decided(fromFile.value)) return of(fromFile.value, 'plan');
    if (decided(fromEnv.value)) return of(fromEnv.value, 'env');
  } else {
    const noPlan = parseAllowance(env[NO_PLAN_ENV]);
    if (!noPlan.ok) return { state: 'invalid', posts: null, source: 'none', planId: null, reason: `${NO_PLAN_ENV}: ${noPlan.reason}` };
    if (decided(noPlan.value)) return of(noPlan.value, 'env');
  }
  const platform = parseAllowance(env[PLATFORM_USER_ENV], { min: 1 });
  if (!platform.ok) return { state: 'invalid', posts: null, source: 'none', planId: known, reason: `${PLATFORM_USER_ENV}: ${platform.reason}` };
  if (decided(platform.value)) return of(platform.value, 'platform');
  return { state: 'unconfigured', posts: null, source: 'none', planId: known };
}

/** The per-project monthly cap (a platform setting; unset = no per-project cap). */
export function getProjectAllowance(env = process.env) {
  const parsed = parseAllowance(env[PLATFORM_PROJECT_ENV], { min: 1 });
  if (!parsed.ok || !decided(parsed.value) || parsed.value === UNLIMITED) return null;
  return parsed.value;
}

/**
 * Everything wrong (errors) and everything incomplete (warnings) in the current configuration. Pure: reads only `env` and PLANS.
 * @returns {{ production: boolean, errors: string[], warnings: string[], plans: Record<string, object>, noPlan: object }}
 */
export function validateSocialAiConfig(env = process.env) {
  const production = isProduction(env);
  const errors = [];
  const warnings = [];
  const plans = {};

  for (const id of Object.keys(PLANS)) {
    const fromFile = planConstant(id);
    if (!fromFile.ok) errors.push(`PLANS.${id}.socialAi.calendarPostsPerMonth ${fromFile.reason}`);
    const fromEnv = parseAllowance(env[planAllowanceEnvVar(id)]);
    if (!fromEnv.ok) errors.push(`${planAllowanceEnvVar(id)} ${fromEnv.reason}`);
    const allowance = getSocialAiAllowance(id, env);
    plans[id] = { state: allowance.state, posts: allowance.posts, source: allowance.source };
    if (allowance.state === 'invalid' && fromFile.ok && fromEnv.ok) errors.push(allowance.reason); // a conflict between the two sources
    if (allowance.state === 'unconfigured') {
      warnings.push(`Plan "${id}" has no Social AI calendar allowance (set PLANS.${id}.socialAi.calendarPostsPerMonth or ${planAllowanceEnvVar(id)}).${production ? ' Calendar generation is REFUSED for these accounts until it is set.' : ''}`);
    }
  }

  const noPlan = getSocialAiAllowance(null, env);
  if (noPlan.state === 'invalid') errors.push(noPlan.reason);
  if (noPlan.state === 'unconfigured' && production) warnings.push(`Accounts without a plan have no Social AI allowance (${NO_PLAN_ENV} is unset): calendar generation is REFUSED for them. Set a number (a trial) or 0.`);

  for (const name of [PLATFORM_USER_ENV, PLATFORM_PROJECT_ENV]) {
    const parsed = parseAllowance(env[name], { min: 1 });
    if (!parsed.ok) errors.push(`${name} ${parsed.reason}`);
    else if (parsed.value === UNLIMITED) errors.push(`${name} cannot be "${UNLIMITED}": leave it unset instead`);
  }
  const inFlight = env[IN_FLIGHT_ENV];
  if (inFlight !== undefined && String(inFlight).trim() !== '' && !/^[1-9]\d{0,2}$/.test(String(inFlight).trim())) errors.push(`${IN_FLIGHT_ENV} must be a whole number from 1 to 999`);
  for (const name of COST_ENVS) {
    const v = env[name];
    if (v !== undefined && String(v).trim() !== '' && !(Number.isFinite(Number(v)) && Number(v) > 0)) errors.push(`${name} must be a positive number (USD per million tokens)`);
  }

  // A dearer plan must not include LESS than a cheaper one.
  const ordered = Object.values(PLANS).slice().sort((a, b) => (a.price || 0) - (b.price || 0));
  let previous = null;
  for (const plan of ordered) {
    const a = plans[plan.id];
    if (!a || !['limited', 'unlimited'].includes(a.state)) continue;
    const rank = a.state === 'unlimited' ? Infinity : a.posts;
    if (previous && rank < previous.rank) errors.push(`Plan "${plan.id}" (${plan.price} ${plan.currency || ''}) includes fewer calendar posts (${a.state === 'unlimited' ? UNLIMITED : a.posts}) than the cheaper plan "${previous.id}" (${previous.shown})`.replace('  ', ' '));
    previous = { id: plan.id, rank, shown: a.state === 'unlimited' ? UNLIMITED : a.posts };
  }

  return { production, errors, warnings, plans, noPlan: { state: noPlan.state, posts: noPlan.posts, source: noPlan.source } };
}

/** Startup check: throws SocialAiConfigError when anything is invalid or contradictory; returns the report (with warnings) otherwise. */
export function assertSocialAiConfig(env = process.env) {
  const report = validateSocialAiConfig(env);
  if (report.errors.length) throw new SocialAiConfigError(report.errors);
  return report;
}

export default { getSocialAiAllowance, getProjectAllowance, validateSocialAiConfig, assertSocialAiConfig, parseAllowance, planAllowanceEnvVar, isProduction, UNLIMITED };
