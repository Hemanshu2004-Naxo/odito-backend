/**
 * Industry taxonomy: the stable, machine-readable values a project's `industry` may hold, with their display labels.
 * Mirrored in frontend/lib/industries.js (keep the two in sync; a test compares them).
 *
 * Three different things, never substituted for one another:
 *   business_type  HOW the business operates ("Service-based", "E-commerce"...)   - free text from onboarding, never an industry
 *   industry       WHAT sector it is in (this list)                               - e.g. healthcare
 *   sub_industry   the specific kind of business, in the customer's words         - e.g. "eye hospital"
 *
 * Projects created before this list existed may hold free text in `industry`; that is left untouched and treated as a
 * sub-industry hint by the AI Visibility profile (see businessProfileService), never rewritten automatically.
 */
export const INDUSTRIES = Object.freeze([
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'education', label: 'Education' },
  { value: 'technology', label: 'Technology & software' },
  { value: 'finance', label: 'Finance & insurance' },
  { value: 'professional_services', label: 'Professional services' },
  { value: 'marketing_advertising', label: 'Marketing & advertising' },
  { value: 'legal', label: 'Legal' },
  { value: 'retail_ecommerce', label: 'Retail & e-commerce' },
  { value: 'hospitality_food', label: 'Hospitality & food' },
  { value: 'travel_tourism', label: 'Travel & tourism' },
  { value: 'real_estate_construction', label: 'Real estate & construction' },
  { value: 'home_services', label: 'Home services' },
  { value: 'beauty_wellness', label: 'Beauty & wellness' },
  { value: 'automotive', label: 'Automotive' },
  { value: 'manufacturing', label: 'Manufacturing' },
  { value: 'other', label: 'Other' },
]);

export const INDUSTRY_VALUES = Object.freeze(new Set(INDUSTRIES.map((i) => i.value)));
export const isIndustryValue = (v) => typeof v === 'string' && INDUSTRY_VALUES.has(v);
export const industryLabel = (v) => INDUSTRIES.find((i) => i.value === v)?.label || null;

/** Where a project's target city came from. Only `user_entered` and `google_places` are confirmed. */
export const LOCATION_SOURCES = Object.freeze(['user_entered', 'google_places', 'website_inferred']);

export default { INDUSTRIES, INDUSTRY_VALUES, isIndustryValue, industryLabel, LOCATION_SOURCES };
