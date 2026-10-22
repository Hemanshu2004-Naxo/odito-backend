/**
 * Review theme taxonomy - deterministic, configurable topic definitions.
 *
 * Each theme lists:
 *  - terms:   single words. Matched against the review's normalized words
 *             (plurals folded, so "doctors" matches "doctor"). Titles and
 *             stop words ARE available to theme matching ("dr" counts as a
 *             doctor mention) even though they are hidden from keyword lists.
 *  - phrases: optional multi-word expressions, matched as whole-word sequences.
 *
 * A review can match any number of themes. Add / rename / remove entries here -
 * no code change is needed. The taxonomy was drawn up from the most frequent
 * words in the real Krishna Eye Centre reviews (staff, doctor, surgery,
 * cataract, treatment, explained, polite, process, checkup, consultation...)
 * plus the standard service-review topics (waiting, pricing, facility) that
 * matter even when currently rare.
 *
 * `id` values are stable API identifiers - don't change them once shipped.
 */
export const REVIEW_THEMES = [
  {
    id: 'doctors',
    name: 'Doctors',
    terms: ['doctor', 'dr', 'surgeon', 'specialist', 'physician', 'ophthalmologist', 'consultant', 'optometrist'],
  },
  {
    id: 'staff',
    name: 'Staff & Team',
    terms: ['staff', 'team', 'nurse', 'receptionist', 'reception', 'counsellor', 'counselor', 'coordinator', 'technician', 'employee', 'personnel', 'assistant', 'helper'],
  },
  {
    id: 'treatment',
    name: 'Treatment & Surgery',
    terms: ['treatment', 'surgery', 'operation', 'procedure', 'cataract', 'lasik', 'laser', 'retina', 'glaucoma', 'squint', 'implant', 'operated', 'treated'],
  },
  {
    id: 'consultation',
    name: 'Consultation & Checkup',
    terms: ['consultation', 'consult', 'checkup', 'diagnosis', 'diagnosed', 'examination', 'exam', 'test', 'screening', 'scan', 'report'],
    phrases: ['check up'],
  },
  {
    id: 'communication',
    name: 'Communication & Guidance',
    terms: ['explained', 'explain', 'explains', 'explanation', 'counselling', 'counseling', 'guidance', 'guided', 'clarity', 'clearly', 'listened', 'listens', 'understood', 'answered', 'informed', 'advice'],
  },
  {
    id: 'behaviour',
    name: 'Care & Behaviour',
    terms: ['care', 'caring', 'polite', 'kind', 'friendly', 'courteous', 'respectful', 'supportive', 'cooperative', 'helpful', 'humble', 'behaviour', 'behavior', 'attitude', 'compassionate', 'empathetic', 'warm', 'patience', 'professional', 'professionalism'],
  },
  {
    id: 'waiting',
    name: 'Waiting & Appointments',
    terms: ['wait', 'waiting', 'waited', 'delay', 'delayed', 'queue', 'crowd', 'crowded', 'appointment', 'schedule', 'scheduled', 'punctual', 'prompt', 'promptly', 'quick', 'quickly', 'timely', 'fast', 'slow'],
    phrases: ['on time', 'waiting time', 'long wait'],
  },
  {
    id: 'pricing',
    name: 'Pricing & Billing',
    terms: ['price', 'prices', 'pricing', 'cost', 'costly', 'charge', 'charges', 'fee', 'fees', 'expensive', 'affordable', 'cheap', 'reasonable', 'billing', 'bill', 'payment', 'insurance', 'mediclaim', 'discount', 'package', 'money'],
  },
  {
    id: 'facility',
    name: 'Facility & Hygiene',
    terms: ['clinic', 'hospital', 'facility', 'facilities', 'room', 'ambience', 'ambiance', 'clean', 'cleanliness', 'hygiene', 'hygienic', 'infrastructure', 'equipment', 'technology', 'modern', 'building', 'parking', 'comfortable'],
  },
  {
    id: 'vision',
    name: 'Vision & Eye Care',
    terms: ['vision', 'eyesight', 'glasses', 'spectacles', 'lens', 'sight', 'optical'], // 'eye' deliberately omitted: it is in the business name, so it would match nearly every review
  },
  {
    id: 'satisfaction',
    name: 'Satisfaction & Recommendation',
    terms: ['recommend', 'recommended', 'recommendation', 'satisfied', 'satisfaction', 'happy', 'thankful', 'grateful', 'trust', 'trusted', 'excellent', 'best', 'outstanding'],
  },
  {
    id: 'results',
    name: 'Results & Recovery',
    terms: ['result', 'results', 'recovery', 'recovered', 'improved', 'improvement', 'healed', 'relief', 'outcome', 'successful', 'success'],
  },
];

/** Minimum reviews a theme needs in the period before it is reported ("recurring"). */
export const MIN_THEME_REVIEWS = 2;
