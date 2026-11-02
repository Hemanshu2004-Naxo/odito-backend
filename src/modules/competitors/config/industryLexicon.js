/**
 * A small lexicon of words that signal each industry (config/industries.js values), used ONLY as a weak, secondary hint when judging
 * whether a website is in the same sector as the project. It is a heuristic for relevance, NOT a provider category mapping: it never
 * decides a class on its own (a project's own sub-industry, services and connected Google Business Profile categories are the strong
 * terms). Edit freely; a test pins the shape.
 */
export const INDUSTRY_LEXICON = Object.freeze({
  healthcare: ['hospital', 'clinic', 'medical', 'doctor', 'surgery', 'surgeon', 'patient', 'treatment', 'healthcare'],
  education: ['school', 'college', 'university', 'course', 'admission', 'students', 'tuition', 'academy'],
  technology: ['software', 'saas', 'app development', 'cloud', 'it services', 'platform', 'developer'],
  finance: ['loan', 'insurance', 'bank', 'investment', 'mutual fund', 'finance', 'wealth'],
  professional_services: ['consulting', 'consultancy', 'advisory', 'accounting', 'audit', 'services firm'],
  marketing_advertising: ['marketing', 'advertising', 'seo', 'branding', 'digital agency', 'social media'],
  legal: ['law firm', 'lawyer', 'advocate', 'attorney', 'legal services', 'litigation'],
  retail_ecommerce: ['shop', 'store', 'buy online', 'products', 'cart', 'shipping'],
  hospitality_food: ['restaurant', 'cafe', 'menu', 'hotel', 'catering', 'bakery', 'dining'],
  travel_tourism: ['tour', 'travel', 'holiday', 'trip', 'itinerary', 'visa'],
  real_estate_construction: ['property', 'real estate', 'apartments', 'builder', 'construction', 'flats'],
  home_services: ['plumbing', 'electrician', 'repair', 'cleaning', 'pest control', 'home services'],
  beauty_wellness: ['salon', 'spa', 'beauty', 'skin', 'wellness', 'massage', 'gym'],
  automotive: ['car', 'cars', 'vehicle', 'garage', 'dealership', 'auto service', 'tyres'],
  manufacturing: ['manufacturer', 'manufacturing', 'factory', 'industrial', 'oem', 'fabrication'],
});
