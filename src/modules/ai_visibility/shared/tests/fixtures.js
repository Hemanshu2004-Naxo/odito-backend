import mongoose from 'mongoose';
import { normalizeBusinessProfile } from '../services/businessProfileService.js';

/** Plain-object project as SeoProject.lean() returns it. */
export function makeProject(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    user_id: new mongoose.Types.ObjectId(),
    project_name: 'asg-eye',
    main_url: 'https://www.asgeye.example/',
    canonical_host: 'www.asgeye.example',
    business_name: null,
    // A real Google Places listing carries a placeId; only then is its city treated as verified.
    verified_business: { placeId: 'place-asg-1', name: 'ASG Eye Hospital', city: 'Ahmedabad', state: 'Gujarat', countryCode: 'IN' },
    industry: 'Eye care', // legacy free text (pre-taxonomy projects); read as the sub-industry
    seo_scope: 'local',
    location: 'Ahmedabad, Gujarat',
    country: 'IN',
    language: 'en',
    keywords: ['lasik'],
    description: 'Eye hospital.',
    ...overrides,
  };
}

export function makeSocial(overrides = {}) {
  return {
    services: [{ name: 'LASIK surgery', status: 'active' }, { name: 'Cataract surgery', status: 'active' }, { name: 'Old thing', status: 'archived' }],
    competitors: [{ name: 'Sankara Eye Care' }, { name: 'Vasan Eye Care' }],
    ...overrides,
  };
}

export function makeProfile({ project = {}, social = makeSocial() } = {}) {
  return normalizeBusinessProfile({ project: makeProject(project), socialProfile: social });
}
