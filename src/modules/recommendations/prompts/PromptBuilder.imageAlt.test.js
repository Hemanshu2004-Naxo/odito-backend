import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import promptBuilder from './PromptBuilder.js';
import recommendationNormalizer from '../service/recommendationNormalizer.js';

const FB = 'https://www.facebook.com/tr?id=1064713942451011&ev=PageView&noscript=1';
const A = 'https://site.example/wp-content/uploads/2025/12/david-peterson-testimonials-120x120.webp';
const B = 'https://site.example/wp-content/uploads/2025/12/emily-tran-testimonial-120x120.webp';

const rc = (srcs, over = {}) => ({
  identity: { issueId: 'images_missing_alt_text' },
  currentState: { isAbsent: srcs.length === 0, label: null, summary: '', tableRows: srcs.map((Image) => ({ Image, 'Current Alt': 'Missing', Status: 'Missing' })), measurement: {} },
  pageContext: { pageUrl: 'https://site.example/about-us', pageType: 'about', framework: 'unknown', cms: 'wordpress' },
  missingElementContext: null, contentContext: {},
  recommendationObjective: { action: 'generate', target: 'alt text for images', constraint: 'under 125 characters per image', successCriteria: 'All images have alt text', preserveContext: 'x', promptMode: 'element_add' },
  ...over,
});

describe('images_missing_alt_text prompt — one structured entry per listed image', () => {
  test('lists the EXACT image URLs (never a tracker) and asks for the structured imageAlts field', () => {
    const { prompt, group } = promptBuilder.build(rc([FB, A, B]), {});
    assert.equal(group, 5);
    assert.match(prompt, /AFFECTED IMAGES/);
    assert.ok(prompt.includes(`[1] ${A}`) && prompt.includes(`[2] ${B}`));
    assert.ok(!prompt.includes('facebook.com/tr'), 'a tracker never reaches the model');
    assert.match(prompt, /"imageAlts"/);
    assert.match(prompt, /Never include a src that is not listed/);
    assert.match(prompt, /"alt": null/);
    assert.match(prompt, /Do NOT invent people/);
  });

  test('another issue type is unaffected', () => {
    const other = rc([A], { identity: { issueId: 'form_labels' } });
    assert.ok(!promptBuilder.build(other, {}).prompt.includes('imageAlts'));
  });
});

describe('normalizer — stores only proposals for the listed images', () => {
  const raw = (alts) => ({ issueAnalysis: 'Two images lack alt text.', recommendedVersion: 'x', implementationNotes: '1. Do it', implementationCode: '<img>', impacts: ['a'], imageAlts: alts });

  test('keeps exact-url entries, drops invented/tracker ones, and always sets the field for this issue', () => {
    const ctx = rc([FB, A, B]);
    const s = recommendationNormalizer.normalize(raw([
      { src: A, alt: 'David Peterson, client testimonial', basis: 'file name' },
      { src: FB, alt: 'Facebook pixel' },
      { src: 'https://invented.example/x.jpg', alt: 'invented' },
    ]), {}, {}, ctx);
    assert.deepEqual(s.imageAltProposals.map((p) => [p.src, p.alt]), [[A, 'David Peterson, client testimonial']]);
  });

  test('a recommendation with no imageAlts still carries an (empty) field — it is "new format", not legacy', () => {
    const s = recommendationNormalizer.normalize({ ...raw(undefined), imageAlts: undefined }, {}, {}, rc([A]));
    assert.deepEqual(s.imageAltProposals, []);
  });

  test('other issues never get the field', () => {
    const s = recommendationNormalizer.normalize(raw([{ src: A, alt: 'x y' }]), {}, {}, rc([A], { identity: { issueId: 'title_missing' } }));
    assert.equal(s.imageAltProposals, undefined);
  });
});
