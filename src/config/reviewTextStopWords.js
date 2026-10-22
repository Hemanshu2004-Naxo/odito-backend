/**
 * Stop words + token rules for review keyword extraction.
 *
 * Kept as DATA (not buried in a service/controller) so it is easy to extend:
 *  - add words to an existing list,
 *  - add a language by adding an entry to STOP_WORDS_BY_LANGUAGE and mapping
 *    its Unicode script in SCRIPT_LANGUAGE.
 *
 * Supported today: English (Latin script). Reviews in other scripts
 * (e.g. Devanagari for Hindi/Marathi, Arabic) are NOT corrupted - their tokens
 * are kept as-is - but they have no stop-word list yet, so common function
 * words in those languages are not filtered (a keyword must appear in several
 * reviews to surface at all, which keeps rare one-off scripts out of the results).
 */

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

// Function words, auxiliaries, pronouns, intensifiers and generic review filler.
const EN = words(`
a about above after again against all almost along already also although always am among an and another any anyone
anything are aren around as at away back be became because become becomes been before being below between both but by
came can cannot cant come comes could couldn did didn do does doesn doing don done down during each either else enough
even ever every everyone everything few for from further get gets getting give given go goes going gone got had hadn has
hasn have haven having he her here hers herself hes him himself his how however i id if ill im in into is isn it its itself
ive just keep kept know last least less let like likely made make makes making many may maybe me might more most much must
my myself need needs neither never next no nobody none nor not nothing now of off often on once one only onto or other
others our ours ourselves out over own per perhaps put quite rather really said same say says see seen several she shes
should shouldn since so some somebody someone something still such take taken than that thats the their theirs them
themselves then there theres these they theyd theyll theyre theyve thing things this those though through throughout thus
to too took toward towards under until up upon us use used using very via want wants was wasn way we wed well went were
weren what whatever when whenever where whether which while who whoever whom whose why will with within without won would
wouldn yet you youd youll your youre yours yourself yourselves youve
dont didnt doesnt isnt wasnt couldnt wouldnt shouldnt wont havent hasnt hadnt arent werent
highly extremely totally absolutely truly definitely actually basically simply
visit visited visiting visits day days today yesterday
translated google original
entire overall related surely whole completely throughout ones
`);

// Honorifics / titles - never useful as a keyword on their own ("dr gul nankani" is
// still found as the phrase "gul nankani").
const TITLES = words('dr drs mr mrs ms miss sir madam maam mam prof');

export const STOP_WORDS_BY_LANGUAGE = {
  en: new Set([...EN, ...TITLES]),
};

/** Unicode script -> language key into STOP_WORDS_BY_LANGUAGE. Other scripts: no list (tokens kept). */
export const SCRIPT_LANGUAGE = { Latin: 'en' };

/** Languages with a stop-word list today (surfaced in the API so the UI/docs never over-claim). */
export const SUPPORTED_LANGUAGES = Object.keys(STOP_WORDS_BY_LANGUAGE);

/** Token length rules. Short domain terms are kept via the allow-list. */
export const TOKEN_RULES = {
  minLatinLength: 3,
  minOtherScriptLength: 2,
  maxLength: 40,
  // Meaningful 2-letter terms in healthcare / service reviews.
  shortTermAllowList: new Set(['ent', 'iv', 'ct', 'ot', 'opd', 'icu', 'mri', 'iol', 'er', 'ac', 'pg']),
};

/** Words whose trailing "s" is part of the word - never fold them to a singular. */
export const PLURAL_FOLD_EXCEPTIONS = new Set([
  'lens', 'series', 'news', 'bus', 'gas', 'plus', 'status', 'canvas', 'always', 'perhaps', 'yes', 'this', 'his', 'was',
  'has', 'its', 'ours', 'class', 'glass', 'process', 'access', 'success', 'business', 'address', 'cornea', 'iris',
  'diabetes', 'analysis', 'diagnosis', 'emphasis', 'basis', 'thesis', 'kudos', 'chaos', 'cosmos', 'pancreas',
]);

/** Extraction thresholds (how much evidence a term needs before it is shown). */
export const KEYWORD_RULES = {
  maxWords: 60,
  maxPhrases: 30,
  minWordReviews: 2,
  /** phrases need more evidence than words; relaxed for small periods so 7D can still show some */
  minPhraseReviews: 3,
  minPhraseReviewsSmallPeriod: 2,
  smallPeriodTextReviews: 30,
  /** a phrase must account for >= this share of the rarer word's reviews (filters accidental adjacency) */
  minPhraseCohesion: 0.25,
  /** below this many reviews with text there is nothing meaningful to rank */
  minTextReviews: 3,
};
