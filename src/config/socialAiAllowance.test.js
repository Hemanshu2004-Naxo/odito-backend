import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PLANS } from './plans.js';
import {
  getSocialAiAllowance, getProjectAllowance, validateSocialAiConfig, assertSocialAiConfig, parseAllowance, planAllowanceEnvVar, SocialAiConfigError, UNLIMITED,
} from './socialAiAllowance.js';

/**
 * Pure tests (no database): where a plan's Social AI calendar allowance comes from, what counts as invalid, what a missing value means.
 * Every function takes the environment as an argument, so nothing here touches process.env.
 */

const ENV = { starter: 'SOCIAL_AI_STARTER_CALENDAR_POSTS_PER_MONTH', pro: 'SOCIAL_AI_PRO_CALENDAR_POSTS_PER_MONTH', premium: 'SOCIAL_AI_PREMIUM_CALENDAR_POSTS_PER_MONTH' };
const PROD = { NODE_ENV: 'production' };

describe('plans.js carries the entitlement', () => {
  test('1: every plan has a socialAi.calendarPostsPerMonth entry (a number, "unlimited", or null = not decided yet) and a derived deployment setting', () => {
    assert.deepEqual(Object.keys(PLANS).sort(), ['premium', 'pro', 'starter'], 'a new plan must be considered here too');
    for (const [id, plan] of Object.entries(PLANS)) {
      assert.ok(plan.socialAi && 'calendarPostsPerMonth' in plan.socialAi, `${id} has no socialAi entitlement`);
      const value = plan.socialAi.calendarPostsPerMonth;
      assert.ok(value === null || value === UNLIMITED || Number.isInteger(value), `${id}: ${value}`);
      assert.equal(planAllowanceEnvVar(id), ENV[id]);
    }
  });
});

describe('parseAllowance', () => {
  test('2: whole numbers and the word unlimited are accepted; blank is "not set"; everything else is invalid', () => {
    assert.deepEqual(parseAllowance('40'), { ok: true, value: 40 });
    assert.deepEqual(parseAllowance(' 0 '), { ok: true, value: 0 });
    assert.deepEqual(parseAllowance('Unlimited'), { ok: true, value: UNLIMITED });
    assert.deepEqual(parseAllowance(undefined), { ok: true, value: undefined });
    assert.deepEqual(parseAllowance(''), { ok: true, value: undefined });
    assert.deepEqual(parseAllowance('   '), { ok: true, value: undefined });
    for (const bad of ['abc', '-1', '1.5', '10 posts', '1e3', '0x10', 'NaN', 'Infinity', '100001', '99999999999', '+5', ' - ']) assert.equal(parseAllowance(bad).ok, false, bad);
    assert.equal(parseAllowance('0', { min: 1 }).ok, false, 'a platform-wide 0 is refused: it would lock everyone out by accident');
    assert.equal(parseAllowance(-3).ok, false);
    assert.equal(parseAllowance(2.5).ok, false);
  });
});

describe('getSocialAiAllowance', () => {
  test('3: each supported plan reads ITS OWN setting, and a number or unlimited is reported with its source', () => {
    const env = { [ENV.starter]: '30', [ENV.pro]: '120', [ENV.premium]: 'unlimited' };
    assert.deepEqual(getSocialAiAllowance('starter', env), { state: 'limited', posts: 30, source: 'env', planId: 'starter' });
    assert.deepEqual(getSocialAiAllowance('pro', env), { state: 'limited', posts: 120, source: 'env', planId: 'pro' });
    assert.deepEqual(getSocialAiAllowance('premium', env), { state: 'unlimited', posts: null, source: 'env', planId: 'premium' });
  });

  test('4: nothing decided is "unconfigured" - never "unlimited" - for a plan, for no plan, and for an unknown plan id', () => {
    for (const plan of ['starter', 'pro', 'premium', null, undefined, 'ghost-plan']) {
      const a = getSocialAiAllowance(plan, {});
      assert.equal(a.state, 'unconfigured', String(plan));
      assert.equal(a.posts, null);
    }
  });

  test('5: an account with no plan (or a retired plan id) uses the no-plan setting, never another plan\'s', () => {
    const env = { [ENV.pro]: '120', SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH: '6' };
    assert.equal(getSocialAiAllowance(null, env).posts, 6);
    assert.equal(getSocialAiAllowance('ghost-plan', env).posts, 6);
    assert.equal(getSocialAiAllowance('starter', env).state, 'unconfigured', 'starter does not inherit pro or no-plan');
    assert.deepEqual(getSocialAiAllowance(null, { SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH: '0' }), { state: 'limited', posts: 0, source: 'env', planId: null });
  });

  test('6: the older platform-wide number covers every account that has no setting of its own, and loses to a plan\'s own', () => {
    const env = { SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH: '50', [ENV.pro]: '200' };
    assert.deepEqual(getSocialAiAllowance('starter', env), { state: 'limited', posts: 50, source: 'platform', planId: 'starter' });
    assert.deepEqual(getSocialAiAllowance(null, env), { state: 'limited', posts: 50, source: 'platform', planId: null });
    assert.equal(getSocialAiAllowance('pro', env).posts, 200);
  });

  test('7: an invalid value is "invalid" (a hard block), never unconfigured and never unlimited - for plan, no-plan and platform settings', () => {
    assert.equal(getSocialAiAllowance('starter', { [ENV.starter]: 'lots' }).state, 'invalid');
    assert.equal(getSocialAiAllowance(null, { SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH: '-2' }).state, 'invalid');
    assert.equal(getSocialAiAllowance('pro', { SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH: '0' }).state, 'invalid');
    assert.match(getSocialAiAllowance('starter', { [ENV.starter]: 'lots' }).reason, /starter/);
  });

  test('8: the plan file and its deployment setting may agree, but not disagree (the allowance would depend on which is read)', () => {
    const original = PLANS.starter.socialAi;
    try {
      PLANS.starter.socialAi = { calendarPostsPerMonth: 20 };
      assert.deepEqual(getSocialAiAllowance('starter', {}), { state: 'limited', posts: 20, source: 'plan', planId: 'starter' });
      assert.equal(getSocialAiAllowance('starter', { [ENV.starter]: '20' }).source, 'plan', 'agreeing values are fine');
      const conflict = getSocialAiAllowance('starter', { [ENV.starter]: '25' });
      assert.equal(conflict.state, 'invalid');
      assert.match(conflict.reason, /plans\.js says 20/);
      PLANS.starter.socialAi = { calendarPostsPerMonth: 'nonsense' };
      assert.equal(getSocialAiAllowance('starter', {}).state, 'invalid', 'a typo in plans.js is a block, not unlimited');
    } finally {
      PLANS.starter.socialAi = original;
    }
  });
});

describe('getProjectAllowance', () => {
  test('9: the per-project cap is a positive number or none; a bad value is ignored here and reported by validation', () => {
    assert.equal(getProjectAllowance({ SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH: '25' }), 25);
    assert.equal(getProjectAllowance({}), null);
    assert.equal(getProjectAllowance({ SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH: 'abc' }), null);
    assert.ok(validateSocialAiConfig({ SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH: 'abc' }).errors.some((e) => /PROJECT_POSTS_PER_MONTH/.test(e)));
  });
});

describe('validateSocialAiConfig / assertSocialAiConfig (what a server start checks)', () => {
  test('10: a fully decided configuration has no errors and no warnings', () => {
    const env = { ...PROD, [ENV.starter]: '30', [ENV.pro]: '120', [ENV.premium]: 'unlimited', SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH: '0' };
    const report = validateSocialAiConfig(env);
    assert.deepEqual([report.errors, report.warnings, report.production], [[], [], true]);
    assert.deepEqual(report.plans, { starter: { state: 'limited', posts: 30, source: 'env' }, pro: { state: 'limited', posts: 120, source: 'env' }, premium: { state: 'unlimited', posts: null, source: 'env' } });
    assert.doesNotThrow(() => assertSocialAiConfig(env));
  });

  test('11: nothing decided is a WARNING in production that names the consequence (refused), and a quieter one elsewhere - never an error that stops the server', () => {
    const prod = validateSocialAiConfig(PROD);
    assert.deepEqual(prod.errors, []);
    assert.equal(prod.warnings.length, 4, 'three plans and the no-plan accounts');
    assert.ok(prod.warnings.every((w) => /REFUSED/.test(w)));
    assert.ok(prod.warnings.some((w) => w.includes(ENV.premium)));
    const dev = validateSocialAiConfig({});
    assert.deepEqual(dev.errors, []);
    assert.equal(dev.warnings.length, 3);
    assert.ok(dev.warnings.every((w) => !/REFUSED/.test(w)));
    assert.doesNotThrow(() => assertSocialAiConfig(PROD));
  });

  test('12: malformed values stop the start: the error lists every problem and the variable that carries it', () => {
    const env = { ...PROD, [ENV.starter]: 'abc', [ENV.pro]: '-4', SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH: '1.5', SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH: '0', SOCIAL_AI_CALENDAR_QUOTA_MAX_IN_FLIGHT_PER_USER: 'many', SOCIAL_AI_COST_USD_PER_MTOK_INPUT: 'free', SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH: 'unlimited' };
    assert.throws(() => assertSocialAiConfig(env), (error) => {
      assert.ok(error instanceof SocialAiConfigError);
      assert.equal(error.code, 'SOCIAL_AI_CONFIG_INVALID');
      for (const name of [ENV.starter, ENV.pro, 'SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH', 'SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH', 'SOCIAL_AI_CALENDAR_QUOTA_MAX_IN_FLIGHT_PER_USER', 'SOCIAL_AI_COST_USD_PER_MTOK_INPUT', 'SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH']) {
        assert.ok(error.problems.some((p) => p.includes(name)), `${name} is not reported: ${error.problems.join(' | ')}`);
      }
      return true;
    });
  });

  test('13: contradictory values stop the start: a dearer plan that includes less than a cheaper one, and a plan file that disagrees with its setting', () => {
    assert.throws(() => assertSocialAiConfig({ ...PROD, [ENV.starter]: '100', [ENV.pro]: '40' }), /"pro".*fewer calendar posts \(40\).*"starter" \(100\)/);
    assert.throws(() => assertSocialAiConfig({ ...PROD, [ENV.pro]: 'unlimited', [ENV.premium]: '500' }), /"premium".*fewer calendar posts \(500\).*"pro" \(unlimited\)/);
    assert.doesNotThrow(() => assertSocialAiConfig({ ...PROD, [ENV.starter]: '40', [ENV.pro]: '40', [ENV.premium]: 'unlimited' }), 'equal is fine');
    assert.doesNotThrow(() => assertSocialAiConfig({ ...PROD, [ENV.starter]: '40', [ENV.premium]: '100' }), 'a gap (pro undecided) is not a contradiction');
    const original = PLANS.pro.socialAi;
    try {
      PLANS.pro.socialAi = { calendarPostsPerMonth: 90 };
      assert.throws(() => assertSocialAiConfig({ ...PROD, [ENV.pro]: '95' }), /plans\.js says 90/);
    } finally {
      PLANS.pro.socialAi = original;
    }
  });

  test('14: the error text never contains anything but setting names and the offending (non-secret) value, bounded in length', () => {
    const long = 'x'.repeat(500);
    try { assertSocialAiConfig({ [ENV.starter]: long }); assert.fail('should throw'); } catch (error) {
      assert.ok(error.message.length < 600, 'a pasted blob is not echoed whole');
    }
  });
});
