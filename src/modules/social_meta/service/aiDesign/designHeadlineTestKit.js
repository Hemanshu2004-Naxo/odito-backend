/**
 * Test-only: the headline / CTA helpers and a one-line way to build a design request for a caption (shared by designHeadline.test.js).
 * Nothing here is used at runtime.
 */
import { chooseHeadline, boundedHeadline, ctaFromCaption, isCtaSentence, proseSentences, fitHeadline } from './designStrategy.js';
import { buildDesignRequest } from './designBrief.js';

const BASE = { platform: 'facebook', pillar: 'Brand', snapshotData: { business: { name: 'Sample Studio', category: 'Agency' }, brand: { primaryColor: '#0B3A75', accentColor: '#E8590C' } }, seed: 'headline' };

export const buildDesignRequestFor = (caption, extra = {}) => buildDesignRequest({ ...BASE, caption, ...extra });

export { chooseHeadline, boundedHeadline, ctaFromCaption, isCtaSentence, proseSentences, fitHeadline };
