import mongoose from 'mongoose';
import SocialBusinessProfile, { BUSINESS_MODELS, SERVICE_STATUSES } from '../model/SocialBusinessProfile.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import {
  bad, isPlainObject, assertKnownKeys, text, stringList, url, color, font, phone, objectIdString, enumValue, ValidationError,
  MAX_URL_LENGTH, MAX_FONT_LENGTH, MAX_PHONE_LENGTH,
} from './catalogValidation.js';

/**
 * socialBusinessProfileService — validation + persistence of the USER-ENTERED
 * Social Media AI business fields (see model/SocialBusinessProfile.js).
 *
 * Contract:
 *  - Only the fields in EDITABLE_FIELDS can be written. Anything else — a
 *    Google id, a rating, hours, tokens, a Mongo operator — is rejected with
 *    UNKNOWN_FIELD; it is never silently dropped and never persisted.
 *  - Every value is validated and COERCED to a plain primitive here before it
 *    gets near a query, so no client-supplied object can reach Mongo as an
 *    operator ({ $set / $where / ... }).
 *  - The update is built from dotted `$set` paths, so a partial PUT changes
 *    only the fields it names.
 *  - Reads are always scoped by project_id (the caller passes the id that
 *    validateProjectAccess() already authorised).
 */

export const LIMITS = Object.freeze({
  audiencePrimary: 500,
  tonePrimary: 200,
  secondaryItems: 10,
  secondaryLength: 200,
  goals: { items: 10, length: 200 },
  uniqueSellingPoints: { items: 10, length: 300 },
  contentPillars: { items: 10, length: 100 },
  prohibitedPhrases: { items: 30, length: 100 },
  offers: { items: 10, name: 100, description: 500 },
  competitors: { items: 10, name: 100 },
  url: MAX_URL_LENGTH,
  additionalInstructions: 2000,
  font: MAX_FONT_LENGTH,
  overrides: {
    businessName: 150, description: 1000, category: 150, phone: MAX_PHONE_LENGTH, address: 300, serviceAreaItems: 20, serviceAreaLength: 100,
    city: 100, region: 100, country: 100, postalCode: 20, secondaryCategories: { items: 10, length: 100 },
  },
  brand: {
    name: 100, description: 500, voice: 300, tagline: 150, additionalInstructions: 1000,
    personality: { items: 8, length: 60 },
    keyMessages: { items: 10, length: 200 },
    preferredWords: { items: 30, length: 50 },
  },
  services: {
    items: 30, name: 150, description: 1000, category: 100,
    features: { items: 10, length: 200 }, benefits: { items: 10, length: 200 }, tags: { items: 15, length: 40 },
  },
});

const BRAND_VISUAL_FIELDS = ['primaryColor', 'secondaryColor', 'accentColor', 'fontHeading', 'fontBody'];
// Everything the profile PUT may write under `brand`. The logo is deliberately absent: it only changes through
// the logo upload endpoint, which runs the file through the shared media validation.
const BRAND_FIELDS = [...BRAND_VISUAL_FIELDS, 'name', 'description', 'voice', 'personality', 'tagline', 'keyMessages', 'preferredWords', 'additionalInstructions'];
const OVERRIDE_FIELDS = ['businessName', 'description', 'category', 'secondaryCategories', 'phone', 'website', 'address', 'city', 'region', 'country', 'postalCode', 'serviceArea'];
const SERVICE_FIELDS = ['id', 'name', 'description', 'category', 'features', 'benefits', 'serviceUrl', 'tags', 'status'];
export const EDITABLE_FIELDS = Object.freeze([
  'businessModel', 'services', 'audience', 'toneOfVoice', 'goals', 'uniqueSellingPoints', 'offers', 'competitors', 'brand',
  'prohibitedPhrases', 'contentPillars', 'additionalInstructions', 'overrides',
]);

function personaBlock(value, path, primaryMax) {
  if (!isPlainObject(value)) bad(`${path} must be an object.`);
  assertKnownKeys(value, ['primary', 'secondary'], path);
  const set = {};
  if ('primary' in value) set[`${path}.primary`] = text(value.primary, `${path}.primary`, primaryMax);
  if ('secondary' in value) {
    set[`${path}.secondary`] = value.secondary === null ? [] : stringList(value.secondary, `${path}.secondary`, { items: LIMITS.secondaryItems, length: LIMITS.secondaryLength });
  }
  return set;
}

function offers(value) {
  if (!Array.isArray(value)) bad('offers must be a list.');
  if (value.length > LIMITS.offers.items) bad(`offers can have at most ${LIMITS.offers.items} entries.`);
  return value.map((offer, i) => {
    const path = `offers[${i}]`;
    if (!isPlainObject(offer)) bad(`${path} must be an object.`);
    assertKnownKeys(offer, ['name', 'description', 'url'], path);
    return {
      name: text(offer.name, `${path}.name`, LIMITS.offers.name, { required: true }),
      description: text(offer.description, `${path}.description`, LIMITS.offers.description, { multiline: true }) || '',
      url: url(offer.url, `${path}.url`),
    };
  });
}

function competitors(value) {
  if (!Array.isArray(value)) bad('competitors must be a list.');
  if (value.length > LIMITS.competitors.items) bad(`competitors can have at most ${LIMITS.competitors.items} entries.`);
  return value.map((entry, i) => {
    const path = `competitors[${i}]`;
    if (!isPlainObject(entry)) bad(`${path} must be an object.`);
    assertKnownKeys(entry, ['name', 'website'], path);
    return {
      name: text(entry.name, `${path}.name`, LIMITS.competitors.name, { required: true }),
      website: url(entry.website, `${path}.website`),
    };
  });
}

function brand(value) {
  if (!isPlainObject(value)) bad('brand must be an object.');
  assertKnownKeys(value, BRAND_FIELDS, 'brand');
  const set = {};
  const b = LIMITS.brand;
  for (const key of BRAND_FIELDS) {
    if (!(key in value)) continue;
    const path = `brand.${key}`;
    const v = value[key];
    switch (key) {
      case 'primaryColor': case 'secondaryColor': case 'accentColor': set[path] = color(v, path); break;
      case 'fontHeading': case 'fontBody': set[path] = font(v, path); break;
      case 'name': set[path] = text(v, path, b.name); break;
      case 'description': set[path] = text(v, path, b.description, { multiline: true }); break;
      case 'voice': set[path] = text(v, path, b.voice, { multiline: true }); break;
      case 'tagline': set[path] = text(v, path, b.tagline); break;
      case 'additionalInstructions': set[path] = text(v, path, b.additionalInstructions, { multiline: true }); break;
      case 'personality': set[path] = v === null ? [] : stringList(v, path, b.personality); break;
      case 'keyMessages': set[path] = v === null ? [] : stringList(v, path, b.keyMessages); break;
      case 'preferredWords': set[path] = v === null ? [] : stringList(v, path, b.preferredWords); break;
      default: break;
    }
  }
  return set;
}

/**
 * The service list is replaced as a whole (like offers). An entry that carries the `id` of an existing service
 * keeps that id (updateProfile() decides which ids are really the project's own); an entry without one is new.
 */
function services(value) {
  if (!Array.isArray(value)) bad('services must be a list.');
  const s = LIMITS.services;
  if (value.length > s.items) bad(`services can have at most ${s.items} entries.`);
  const seenIds = new Set();
  return value.map((entry, i) => {
    const path = `services[${i}]`;
    if (!isPlainObject(entry)) bad(`${path} must be an object.`);
    assertKnownKeys(entry, SERVICE_FIELDS, path);
    let id = null;
    if (entry.id !== undefined && entry.id !== null) {
      id = objectIdString(entry.id, `${path}.id`);
      if (seenIds.has(id)) bad(`${path}.id is used twice.`);
      seenIds.add(id);
    }
    const list = (key, limits) => (key in entry && entry[key] !== null ? stringList(entry[key], `${path}.${key}`, limits) : []);
    return {
      id,
      name: text(entry.name, `${path}.name`, s.name, { required: true }),
      description: text(entry.description, `${path}.description`, s.description, { multiline: true }) || '',
      category: text(entry.category, `${path}.category`, s.category),
      features: list('features', s.features),
      benefits: list('benefits', s.benefits),
      serviceUrl: url(entry.serviceUrl, `${path}.serviceUrl`, { publicOnly: true }),
      tags: list('tags', s.tags),
      status: 'status' in entry && entry.status !== null ? enumValue(entry.status, `${path}.status`, SERVICE_STATUSES) : 'active',
    };
  });
}

function serviceArea(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return text(value, 'overrides.serviceArea', LIMITS.overrides.address);
  if (Array.isArray(value)) {
    const list = stringList(value, 'overrides.serviceArea', { items: LIMITS.overrides.serviceAreaItems, length: LIMITS.overrides.serviceAreaLength });
    return list.length ? list : null;
  }
  return bad('overrides.serviceArea must be text or a list of place names.');
}

function overrides(value) {
  if (!isPlainObject(value)) bad('overrides must be an object.');
  assertKnownKeys(value, OVERRIDE_FIELDS, 'overrides');
  const set = {};
  const o = LIMITS.overrides;
  if ('businessName' in value) set['overrides.businessName'] = text(value.businessName, 'overrides.businessName', o.businessName);
  if ('description' in value) set['overrides.description'] = text(value.description, 'overrides.description', o.description, { multiline: true });
  if ('category' in value) set['overrides.category'] = text(value.category, 'overrides.category', o.category);
  if ('secondaryCategories' in value) {
    // an empty list clears the override (the resolver then falls back to Google's secondary categories)
    set['overrides.secondaryCategories'] = value.secondaryCategories === null ? [] : stringList(value.secondaryCategories, 'overrides.secondaryCategories', o.secondaryCategories);
  }
  if ('phone' in value) set['overrides.phone'] = phone(value.phone, 'overrides.phone');
  if ('website' in value) set['overrides.website'] = url(value.website, 'overrides.website');
  if ('address' in value) set['overrides.address'] = text(value.address, 'overrides.address', o.address);
  if ('city' in value) set['overrides.city'] = text(value.city, 'overrides.city', o.city);
  if ('region' in value) set['overrides.region'] = text(value.region, 'overrides.region', o.region);
  if ('country' in value) set['overrides.country'] = text(value.country, 'overrides.country', o.country);
  if ('postalCode' in value) {
    const code = text(value.postalCode, 'overrides.postalCode', o.postalCode);
    if (code !== null && !/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(code)) bad('overrides.postalCode contains characters that are not allowed.');
    set['overrides.postalCode'] = code;
  }
  if ('serviceArea' in value) set['overrides.serviceArea'] = serviceArea(value.serviceArea);
  return set;
}

/**
 * Validates a PUT body and turns it into dotted `$set` paths.
 * Returns { set } or { error: { code, message } } — never throws.
 */
export function validateProfileUpdate(body) {
  try {
    if (!isPlainObject(body)) bad('The request body must be an object.', 'INVALID_BODY');
    // projectId is the routing key validateProjectAccess() already used.
    const { projectId: _projectId, ...fields } = body;
    assertKnownKeys(fields, EDITABLE_FIELDS, '');

    const set = {};
    for (const [key, value] of Object.entries(fields)) {
      switch (key) {
        case 'businessModel': set.businessModel = value === null ? null : enumValue(value, 'businessModel', BUSINESS_MODELS); break;
        case 'services': set.services = services(value); break;
        case 'audience': Object.assign(set, personaBlock(value, 'audience', LIMITS.audiencePrimary)); break;
        case 'toneOfVoice': Object.assign(set, personaBlock(value, 'toneOfVoice', LIMITS.tonePrimary)); break;
        case 'goals': set.goals = stringList(value, 'goals', LIMITS.goals); break;
        case 'uniqueSellingPoints': set.uniqueSellingPoints = stringList(value, 'uniqueSellingPoints', LIMITS.uniqueSellingPoints); break;
        case 'contentPillars': set.contentPillars = stringList(value, 'contentPillars', LIMITS.contentPillars); break;
        case 'prohibitedPhrases': set.prohibitedPhrases = stringList(value, 'prohibitedPhrases', LIMITS.prohibitedPhrases); break;
        case 'offers': set.offers = offers(value); break;
        case 'competitors': set.competitors = competitors(value); break;
        case 'brand': Object.assign(set, brand(value)); break;
        case 'overrides': Object.assign(set, overrides(value)); break;
        case 'additionalInstructions':
          set.additionalInstructions = text(value, 'additionalInstructions', LIMITS.additionalInstructions, { multiline: true }) || '';
          break;
        default: break;
      }
    }
    if (Object.keys(set).length === 0) bad('Provide at least one field to update.', 'EMPTY_UPDATE');
    return { set };
  } catch (error) {
    if (error instanceof ValidationError) return { error: { code: error.code, message: error.message } };
    throw error;
  }
}

const toPublicLogo = (logo) => (logo?.url
  ? { url: logo.url, mimeType: logo.mimeType ?? null, width: logo.width ?? null, height: logo.height ?? null, size: logo.size ?? null, updatedAt: logo.updatedAt ?? null }
  : null);

export const toPublicService = (svc) => ({
  id: String(svc._id),
  name: svc.name,
  description: svc.description || '',
  category: svc.category ?? null,
  features: [...(svc.features || [])],
  benefits: [...(svc.benefits || [])],
  serviceUrl: svc.serviceUrl ?? null,
  tags: [...(svc.tags || [])],
  status: svc.status || 'active',
});

const OVERRIDE_TEXT_FIELDS = OVERRIDE_FIELDS.filter((k) => k !== 'secondaryCategories');

/** The persisted manual fields as the API returns them (defaults when nothing was ever saved). Never includes a storage key. */
export function toEditableProfile(doc) {
  const d = doc || {};
  const b = d.brand || {};
  return {
    exists: !!doc,
    businessModel: d.businessModel ?? null,
    services: (d.services || []).map(toPublicService),
    audience: { primary: d.audience?.primary ?? null, secondary: [...(d.audience?.secondary || [])] },
    toneOfVoice: { primary: d.toneOfVoice?.primary ?? null, secondary: [...(d.toneOfVoice?.secondary || [])] },
    goals: [...(d.goals || [])],
    uniqueSellingPoints: [...(d.uniqueSellingPoints || [])],
    offers: (d.offers || []).map((o) => ({ name: o.name, description: o.description || '', url: o.url ?? null })),
    competitors: (d.competitors || []).map((c) => ({ name: c.name, website: c.website ?? null })),
    brand: {
      primaryColor: b.primaryColor ?? null, secondaryColor: b.secondaryColor ?? null, accentColor: b.accentColor ?? null,
      fontHeading: b.fontHeading ?? null, fontBody: b.fontBody ?? null,
      name: b.name ?? null, description: b.description ?? null, voice: b.voice ?? null,
      personality: [...(b.personality || [])], tagline: b.tagline ?? null,
      keyMessages: [...(b.keyMessages || [])], preferredWords: [...(b.preferredWords || [])],
      additionalInstructions: b.additionalInstructions ?? null,
      logo: toPublicLogo(b.logo),
    },
    prohibitedPhrases: [...(d.prohibitedPhrases || [])],
    contentPillars: [...(d.contentPillars || [])],
    additionalInstructions: d.additionalInstructions || '',
    overrides: {
      ...Object.fromEntries(OVERRIDE_TEXT_FIELDS.map((k) => [k, d.overrides?.[k] ?? null])),
      secondaryCategories: d.overrides?.secondaryCategories?.length ? [...d.overrides.secondaryCategories] : null,
    },
    updatedAt: d.updatedAt || null,
  };
}

export async function findProfile(projectId) {
  if (!mongoose.Types.ObjectId.isValid(projectId)) return null;
  return SocialBusinessProfile.findOne({ project_id: projectId }).lean();
}

export async function getEditableProfile(projectId) {
  return toEditableProfile(await findProfile(projectId));
}

const projectMissing = () => ({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found.' } });
const CONFLICT = { success: false, error: { code: 'CONFLICT', message: 'The profile was changed at the same time. Please try again.' } };

// Defence in depth behind validateProjectAccess(): never create a profile for a project that does not exist (or is trashed).
const projectExists = (projectId) => SeoProject.exists({ _id: projectId, is_deleted: { $ne: true } });

/**
 * Upserts with a single retry: two first-time saves racing each other can both try to insert; the unique index
 * rejects one with E11000 and the retry then updates the winner.
 */
async function upsertProfile(projectId, update) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await SocialBusinessProfile.findOneAndUpdate(
        { project_id: projectId },
        update,
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
      ).lean();
    } catch (error) {
      if (error?.code === 11000 && attempt === 0) continue;
      throw error;
    }
  }
  return null;
}

/**
 * Applies a validated partial update for one project. The project id must
 * already have been authorised by the caller (validateProjectAccess()).
 */
export async function updateProfile(projectId, userId, body) {
  if (!mongoose.Types.ObjectId.isValid(projectId)) return projectMissing();
  const validated = validateProfileUpdate(body);
  if (validated.error) return { success: false, error: validated.error };
  if (!(await projectExists(projectId))) return projectMissing();

  const set = { ...validated.set };
  if (set.services) {
    // A service keeps its id only if that id really is one of THIS project's services; an id from anywhere else is
    // treated as a new service, so a client can neither claim another project's id nor invent one.
    const existing = await SocialBusinessProfile.findOne({ project_id: projectId }).select('services._id').lean();
    const known = new Set((existing?.services || []).map((svc) => String(svc._id)));
    set.services = set.services.map(({ id, ...rest }) => ({ ...rest, _id: id && known.has(id) ? new mongoose.Types.ObjectId(id) : new mongoose.Types.ObjectId() }));
  }

  const doc = await upsertProfile(projectId, { $set: { ...set, updatedBy: userId }, $setOnInsert: { createdBy: userId } });
  return doc ? { success: true, profile: toEditableProfile(doc) } : CONFLICT;
}

/**
 * Stores the user's uploaded brand logo reference (the file itself is already in the shared media storage).
 * Returns the storage key of the logo it replaced so the caller can delete that file.
 */
export async function setBrandLogo(projectId, userId, media) {
  if (!mongoose.Types.ObjectId.isValid(projectId)) return projectMissing();
  if (!(await projectExists(projectId))) return projectMissing();
  const previous = await SocialBusinessProfile.findOne({ project_id: projectId }).select('brand.logo.storageKey').lean();
  const doc = await upsertProfile(projectId, {
    $set: {
      'brand.logo': { url: media.url, storageKey: media.storageKey, mimeType: media.mimeType, width: media.width ?? null, height: media.height ?? null, size: media.size ?? null, updatedAt: new Date() },
      updatedBy: userId,
    },
    $setOnInsert: { createdBy: userId },
  });
  return doc ? { success: true, profile: toEditableProfile(doc), previousStorageKey: previous?.brand?.logo?.storageKey || null } : CONFLICT;
}

/** Removes the user's logo reference (the resolver then falls back to the Google / website logo). */
export async function clearBrandLogo(projectId, userId) {
  if (!mongoose.Types.ObjectId.isValid(projectId)) return projectMissing();
  const previous = await SocialBusinessProfile.findOne({ project_id: projectId }).select('brand.logo').lean();
  if (!previous?.brand?.logo?.url) return { success: true, profile: await getEditableProfile(projectId), previousStorageKey: null };
  const doc = await SocialBusinessProfile.findOneAndUpdate(
    { project_id: projectId },
    { $set: { 'brand.logo': { url: null, storageKey: null, mimeType: null, width: null, height: null, size: null, updatedAt: null }, updatedBy: userId } },
    { new: true },
  ).lean();
  return doc ? { success: true, profile: toEditableProfile(doc), previousStorageKey: previous.brand.logo.storageKey || null } : projectMissing();
}

export default { LIMITS, EDITABLE_FIELDS, validateProfileUpdate, toEditableProfile, toPublicService, findProfile, getEditableProfile, updateProfile, setBrandLogo, clearBrandLogo };
