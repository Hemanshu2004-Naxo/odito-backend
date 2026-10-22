import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIX_STRATEGIES, READINESS, capabilityOf, getFixStrategies, readinessFor } from './issueFixStrategies.js';
import { CAPABILITY_REGISTRY, getCapabilityForIssue } from '../../external_integration/service/providerCapabilityRegistry.js';

const MODULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'); // src/modules

describe('issueFixStrategies describes what exists — and cannot drift from it', () => {
  test('every module a strategy names really exists', () => {
    for (const s of FIX_STRATEGIES) {
      for (const stage of ['evidence', 'identification', 'proposal', 'validation', 'verification']) {
        const file = s[stage]?.module;
        assert.ok(file, `${s.id}.${stage} names no module`);
        assert.ok(fs.existsSync(path.join(MODULES, file)), `${s.id}.${stage}: ${file} does not exist`);
      }
    }
  });

  test('every strategy has all six stages and a known readiness', () => {
    for (const s of FIX_STRATEGIES) {
      for (const stage of ['evidence', 'identification', 'proposal', 'validation', 'application', 'verification']) assert.ok(s[stage], `${s.id} lacks ${stage}`);
      assert.ok(READINESS.includes(s.readiness), `${s.id}: ${s.readiness}`);
      assert.ok(s.issueCodes.length && s.property);
    }
    assert.equal(new Set(FIX_STRATEGIES.map((s) => s.id)).size, FIX_STRATEGIES.length, 'ids are unique');
  });

  test('an application claim must agree with the WordPress capability registry', () => {
    for (const s of FIX_STRATEGIES.filter((x) => x.application.capabilityField)) {
      const cap = CAPABILITY_REGISTRY[s.application.capabilityField];
      assert.ok(cap?.supported, `${s.id} claims ${s.application.capabilityField}, which the capability registry does not support`);
      assert.ok(s.issueCodes.every((c) => cap.issueCodes.includes(c)), `${s.id}: issue codes differ from the capability's`);
      if (s.application.provider === 'rank_math') assert.equal(cap.provider, 'rank_math');
      if (s.application.channel === 'schema_fix') assert.equal(cap.typedFix, true);
      assert.ok(capabilityOf(s));
    }
  });

  test('the address strategy matches what the capability registry says about the address field', () => {
    const [address] = getFixStrategies('organization_schema').filter((s) => s.id === 'organization_address');
    const cap = getCapabilityForIssue('organization_schema').capability;
    assert.ok(cap.bridgeField.fields.includes('address'));
    assert.equal(cap.fieldMinBridgeCapability.address, 'organization_address');
    assert.ok(address.application.requires.some((r) => /1\.6\.0/.test(r)));
    assert.equal(address.readiness, 'contract');
  });

  test('readiness is reported bluntly: contract only where the whole chain exists, and unknown issues are recommendation-only', () => {
    assert.equal(readinessFor('organization_schema').readiness, 'contract');
    assert.deepEqual(readinessFor('organization_schema').strategies.sort(), ['organization_address', 'organization_identity']);
    assert.equal(readinessFor('images_missing_alt_text').readiness, 'typed_fix');
    assert.equal(readinessFor('title_missing').readiness, 'single_field');
    assert.equal(readinessFor('meta_description_too_long').readiness, 'single_field');
    assert.equal(readinessFor('some_issue_odito_cannot_apply').readiness, 'recommendation');
    assert.deepEqual(getFixStrategies('nope'), []);
  });

  test('the registry is read-only data', () => {
    assert.throws(() => { 'use strict'; FIX_STRATEGIES.push({}); });
    assert.throws(() => { 'use strict'; FIX_STRATEGIES[0].readiness = 'contract2'; });
  });
});
