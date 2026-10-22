import mongoose from 'mongoose';

const IMPACT_SCORES = { critical: 9, high: 7, medium: 5, low: 3 };

function deriveBotStatuses(crawlability) {
  const robots = crawlability?.robots ?? {};
  const llms   = crawlability?.llms_txt ?? {};
  return {
    gptbot:          robots.gptbot_blocked           ? 'fail'      : 'pass',
    claudebot:       robots.claudebot_blocked         ? 'fail'      : 'pass',
    perplexitybot:   robots.perplexitybot_blocked     ? 'fail'      : 'pass',
    google_extended: robots.google_extended_blocked   ? 'fail'      : 'pass',
    bingbot:         robots.bingbot_blocked           ? 'fail'      : 'pass',
    llms_txt:        llms.exists === false ? 'fail'
                   : llms.is_accurate      ? 'optimized'
                   : 'warning',
  };
}

/**
 * Guard against an impossible (pages_affected > applicable_pages) state
 * before it reaches the API response.
 *
 * Root cause this catches: `GEO_RULE_APPLICABLE_TYPES` below is a Node-side
 * approximation of which pages a rule applies to (by `page_type`), built
 * independently of the Python rule evaluator that actually decided which
 * pages get an `ai_issues` document. For the single-page-type rules
 * (GEO-S1..S5) these two classifications disagree in production — e.g. on
 * a real audited project, GEO-S4 ("product" page rule) had 118 pages
 * flagged as failing while the page_type census found 0 pages typed
 * "product", producing a nonsensical "118 / 0" in the UI. The `lb`-mapped
 * rules (GEO-059..GEO-G3) do not exhibit this — their applicable-page
 * classification does agree with the real data — so this only ever fires
 * for the rules where it's actually needed.
 *
 * Never clamps `pages_affected` (the real, correct count) or inflates
 * `applicable_pages` to make them agree — an unreliable denominator is
 * reported as `null` (the same value already used for domain-scope rules,
 * which the frontend already renders as "just the affected count, no
 * fraction" — see GeoOptimizationPipeline.jsx), and the mismatch is logged
 * so it's visible for the underlying page-type classification to be fixed
 * at the source, rather than silently hidden.
 */
function guardApplicablePages(pagesAffected, applicablePages, context) {
  if (applicablePages != null && pagesAffected > applicablePages) {
    console.warn(
      `[aiHubController] Impossible state: pages_affected (${pagesAffected}) > applicable_pages (${applicablePages}) — ` +
      `treating applicable_pages as unreliable for this rule instead of displaying a nonsensical fraction.`,
      context
    );
    return null;
  }
  return applicablePages;
}

function buildCard(raw) {
  return {
    score:           Math.round(raw?.score           ?? 0),
    rule_count:      raw?.rule_count       ?? 0,
    pages_scored:    raw?.pages_scored     ?? 0,
    checks_executed: raw?.checks_executed  ?? 0,
    total_passed:    raw?.total_passed     ?? 0,
    total_failed:    raw?.total_failed     ?? 0,
  };
}

// GET /api/aiso-hub/:projectId
export const getAISOHubData = async (req, res) => {
  const { projectId } = req.params;

  try {
    const db  = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);

    const aiProjectDoc = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    if (!aiProjectDoc) {
      return res.json({ success: true, data: null });
    }

    const jobId = aiProjectDoc.job_id;
    const aiso  = aiProjectDoc.hubs?.aiso ?? {};
    const cards = aiso.cards ?? {};

    // Run both reads in parallel — they are independent
    const [anyPage, severityRows] = await Promise.all([
      // crawlability is domain-level — any page holds the same data
      db.collection('ai_pages').findOne(
        { project_id: pid, job_id: jobId },
        { projection: { crawlability: 1 } },
      ),
      // AISO-only severity counts from ai_issues (not the all-hub issues_summary)
      db.collection('ai_issues').aggregate([
        { $match: { project_id: pid, job_id: jobId, hub: 'aiso' } },
        { $group: { _id: '$severity', count: { $sum: 1 } } },
      ]).toArray(),
    ]);

    const issueDist = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    for (const { _id, count } of severityRows) {
      if (_id in issueDist) {
        issueDist[_id]   = count;
        issueDist.total += count;
      }
    }

    return res.json({
      success: true,
      data: {
        project_id:   projectId,
        job_id:       jobId,
        pages_scored: aiProjectDoc.pages_scored ?? 0,
        computed_at:  aiProjectDoc.computed_at,
        aiso_score:   Math.round(aiso.score ?? 0),

        hero: {
          aiso:         Math.round(aiso.score              ?? 0),
          crawlability: Math.round(cards.crawlability?.score ?? 0),
          citability:   Math.round(cards.citability?.score   ?? 0),
          authority:    Math.round(cards.authority?.score    ?? 0),
          coverage:     Math.round(cards.coverage?.score     ?? 0),
        },

        bots: deriveBotStatuses(anyPage?.crawlability),

        cards: {
          crawlability: buildCard(cards.crawlability),
          citability:   buildCard(cards.citability),
          authority:    buildCard(cards.authority),
          coverage:     buildCard(cards.coverage),
        },

        issue_distribution: issueDist,
      },
    });
  } catch (err) {
    console.error('[aiHubController] getAISOHubData error:', err, { projectId });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch AISO Hub data',
      error:   err.message,
    });
  }
};

// GET /api/aiso-hub/:projectId/issues/:ruleId  — full URL list for one rule
export const getAISOHubIssueDetail = async (req, res) => {
  const { projectId, ruleId } = req.params;

  try {
    const db  = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);

    const aiProjectDoc = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    if (!aiProjectDoc) {
      return res.json({ success: true, data: null });
    }

    const jobId = aiProjectDoc.job_id;

    const docs = await db.collection('ai_issues')
      .find({ project_id: pid, job_id: jobId, hub: 'aiso', rule_id: ruleId })
      .project({ url: 1, severity: 1, issue_title: 1, issue_description: 1, recommendation: 1, card: 1 })
      .toArray();

    if (docs.length === 0) {
      return res.json({ success: true, data: null });
    }

    const first    = docs[0];
    const isDomain = (first.scope ?? 'page') === 'domain';
    return res.json({
      success: true,
      data: {
        rule_id:           ruleId,
        card:              first.card,
        scope:             first.scope ?? 'page',
        issue_title:       first.issue_title,
        issue_description: first.issue_description,
        recommendation:    first.recommendation,
        severity:          first.severity,
        impact_score:      IMPACT_SCORES[first.severity] ?? 5,
        pages_affected:    isDomain ? null : docs.length,
        affected_scope:    isDomain ? 'Entire Website' : null,
        affected_urls:     isDomain ? [] : docs.map(d => d.url),
      },
    });
  } catch (err) {
    console.error('[aiHubController] getAISOHubIssueDetail error:', err, { projectId, ruleId });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch AISO issue detail',
      error:   err.message,
    });
  }
};

// ── AEO Hub controllers ───────────────────────────────────────────────────────

// GET /api/aeo-hub/:projectId
export const getAEOHubData = async (req, res) => {
  const { projectId } = req.params;

  try {
    const db  = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);

    const aiProjectDoc = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    if (!aiProjectDoc) {
      return res.json({ success: true, data: null });
    }

    const jobId       = aiProjectDoc.job_id;
    const aeo         = aiProjectDoc.hubs?.aeo ?? {};
    const cards       = aeo.cards ?? {};
    const pagesScored = aiProjectDoc.pages_scored ?? 1;

    const [severityRows, pageScoreDocs, structureAgg, faqOpportunityDocs] = await Promise.all([
      // Q1: AEO-only severity distribution
      db.collection('ai_issues').aggregate([
        { $match: { project_id: pid, job_id: jobId, hub: 'aeo' } },
        { $group: { _id: '$severity', count: { $sum: 1 } } },
      ]).toArray(),

      // Q2: per-page, per-rule PASS/FAIL/SKIPPED results for the 5 readiness
      // signals — read from ai_scores (project_id-scoped, same convention
      // project_aggregator.py itself uses for card scores; NOT job_id-scoped,
      // since ai_scores holds current-per-URL state, not one doc per run).
      //
      // Root-cause fix: this used to count only `ai_issues` FAIL documents
      // and divide by `pagesScored` (every page). But several of these rules
      // are page-type-gated (see page_type_matrix.py's SKIP_MATRIX) and
      // SKIPPED pages never get an ai_issues document — so a page the rule
      // never applied to was silently counted as "passing" in the old
      // denominator, inflating every gated rule's score. Confirmed on a
      // real project: AEO-048 (FAQ Schema) actually fails on 6/6 of the
      // pages it applies to (100% fail — the site's FAQ schema has zero
      // matching visible content anywhere), while the old formula reported
      // "78% pass" because 21 of 27 pages were SKIPPED (wrong page type for
      // this rule) and got counted as passes. `ai_scores.hubs.aeo.cards.*.rules.<rule_id>.result`
      // is written by the same registry.evaluate_page() call that produces
      // ai_issues, so reading it here can never disagree with Python's own
      // applicability determination — unlike reimplementing page-type
      // matching independently in Node (the exact mistake already fixed for
      // GEO-S1..S5's applicable_pages).
      db.collection('ai_scores')
        .find({ project_id: pid }, { projection: { 'hubs.aeo.cards': 1 } })
        .toArray(),

      // Q3: ai_pages aggregation for content structure + FAQ metrics
      db.collection('ai_pages').aggregate([
        { $match: { project_id: pid, job_id: jobId } },
        { $group: {
            _id:                   null,
            total_h2_sum:          { $sum: '$content.total_h2' },
            question_h2_sum:       { $sum: '$content.question_h2_count' },
            schema_qa_total:       { $sum: '$faq.schema_qa_count' },
            visible_qa_total:      { $sum: '$faq.visible_qa_count' },
            matched_qa_total:      { $sum: '$faq.matched_count' },
            pages_with_faq_schema: { $sum: { $cond: ['$faq.schema_present', 1, 0] } },
            lists_total:           { $sum: '$content.lists.qualifying' },
            tables_total:          { $sum: '$content.tables.qualifying' },
            authority_links_total: { $sum: '$content.external_links.authority' },
            pages_speakable:       { $sum: {
                $cond: [{ $gt: [{ $ifNull: ['$schema.speakable', null] }, null] }, 1, 0],
            }},
            question_h2_ratio_sum: { $sum: '$content.question_h2_ratio' },
            page_count:            { $sum: 1 },
        }},
      ]).toArray(),

      // Q4: AEO-048 failures — flatten evidence.mismatches for FAQ opportunities
      db.collection('ai_issues').find(
        { project_id: pid, job_id: jobId, hub: 'aeo', card: 'faq_coverage' },
        { projection: { evidence: 1, recommendation: 1 } },
      ).toArray(),
    ]);

    // ── Issue Distribution ───────────────────────────────────────────────────
    const issueDist = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    for (const { _id, count } of severityRows) {
      if (_id in issueDist) {
        issueDist[_id]   = count;
        issueDist.total += count;
      }
    }

    // ── Answer Readiness Signals ─────────────────────────────────────────────
    // Tally applicable (non-SKIPPED) vs. passed pages per rule_id by scanning
    // every card's `rules` block on every page's ai_scores doc — rule_id is
    // unique, so this doesn't need to know which card a given rule lives
    // under (that mapping lives only in Python's HUB_CARD_MAP; duplicating
    // it here would reintroduce the same class of drift this fix removes).
    const ruleStats = {}; // rule_id -> { applicable, passed, failing }
    for (const scoreDoc of pageScoreDocs) {
      const cardBlocks = scoreDoc.hubs?.aeo?.cards ?? {};
      for (const card of Object.values(cardBlocks)) {
        for (const [ruleId, rule] of Object.entries(card.rules ?? {})) {
          if (rule.result === 'SKIPPED') continue;
          const stats = (ruleStats[ruleId] ??= { applicable: 0, passed: 0, failing: 0 });
          stats.applicable += 1;
          if (rule.result === 'PASS') stats.passed += 1;
          else stats.failing += 1;
        }
      }
    }

    function buildSignal(ruleId) {
      const stats = ruleStats[ruleId] ?? { applicable: 0, passed: 0, failing: 0 };
      const score = stats.applicable > 0
        ? Math.round((stats.passed / stats.applicable) * 100)
        : 0;
      return {
        rule_id:          ruleId,
        pages_failing:    stats.failing,
        applicable_pages: stats.applicable,
        score,
        status: stats.applicable === 0 ? 'not_applicable' : score >= 70 ? 'pass' : score >= 40 ? 'warning' : 'fail',
      };
    }

    // ── Content Structure ────────────────────────────────────────────────────
    const st          = structureAgg[0] ?? {};
    const totalH2     = st.total_h2_sum    ?? 0;
    const questionH2  = st.question_h2_sum ?? 0;
    const schemaQa    = st.schema_qa_total ?? 0;
    const matchedQa   = st.matched_qa_total ?? 0;
    const pagesSpeak  = st.pages_speakable ?? 0;
    const pageCount   = st.page_count      ?? 1;
    const avgQH2Ratio = (st.question_h2_ratio_sum ?? 0) / pageCount;

    const ratioDisplay = questionH2 > 0
      ? `1:${Math.round(totalH2 / questionH2)}`
      : '0:0';

    const convLabel = avgQH2Ratio >= 0.30 ? 'HIGH'
                    : avgQH2Ratio >= 0.15 ? 'MEDIUM'
                    : 'LOW';

    // ── FAQ Opportunities (AEO-048 mismatch flatten) ─────────────────────────
    const mismatchMap = new Map();
    for (const doc of faqOpportunityDocs) {
      for (const question of (doc.evidence?.mismatches ?? [])) {
        if (!question) continue;
        if (mismatchMap.has(question)) {
          mismatchMap.get(question).affected_url_count += 1;
        } else {
          mismatchMap.set(question, {
            question,
            status:             'missing_schema',
            recommendation:     doc.recommendation ?? '',
            impact:             'high',
            affected_url_count: 1,
          });
        }
      }
    }
    const faqOpportunities = [...mismatchMap.values()]
      .sort((a, b) => b.affected_url_count - a.affected_url_count)
      .slice(0, 6);

    // ── Card builder ─────────────────────────────────────────────────────────
    function buildAEOCard(raw) {
      const score = Math.round(raw?.score ?? 0);
      return {
        score,
        rule_count:   raw?.rule_count   ?? 0,
        pages_scored: raw?.pages_scored ?? 0,
        total_failed: raw?.total_failed ?? 0,
        status: score >= 70 ? 'OPTIMAL' : score >= 40 ? 'NEEDS WORK' : 'CRITICAL',
      };
    }

    return res.json({
      success: true,
      data: {
        project_id:   projectId,
        job_id:       jobId,
        pages_scored: pagesScored,
        computed_at:  aiProjectDoc.computed_at,

        aeo_score: Math.round(aeo.score ?? 0),

        cards: {
          answer_readiness:  buildAEOCard(cards.answer_readiness),
          question_coverage: buildAEOCard(cards.question_coverage),
          faq_coverage:      buildAEOCard(cards.faq_coverage),
          snippet_score:     buildAEOCard(cards.snippet_score),
          voice_search:      buildAEOCard(cards.voice_search),
        },

        signals: {
          direct_answer:    buildSignal('AEO-046'),
          question_h2:      buildSignal('AEO-047'),
          faq_schema:       buildSignal('AEO-048'),
          howto_schema:     buildSignal('AEO-049'),
          speakable_schema: buildSignal('AEO-055'),
        },

        structure: {
          question_coverage: {
            total_h2_sum:    totalH2,
            question_h2_sum: questionH2,
            ratio_display:   ratioDisplay,
          },
          faq_intelligence: {
            schema_qa_total:       schemaQa,
            visible_qa_total:      st.visible_qa_total    ?? 0,
            matched_qa_total:      matchedQa,
            schema_match_pct:      schemaQa > 0 ? Math.round((matchedQa / schemaQa) * 100) : 0,
            pages_with_faq_schema: st.pages_with_faq_schema ?? 0,
          },
          snippet_readiness: {
            lists_total:           st.lists_total           ?? 0,
            tables_total:          st.tables_total          ?? 0,
            authority_links_total: st.authority_links_total ?? 0,
          },
          voice_readiness: {
            pages_speakable:        pagesSpeak,
            speakable_coverage_pct: Math.round((pagesSpeak / pagesScored) * 100),
            speakable_active:       pagesSpeak > 0,
            conversational_label:   convLabel,
          },
        },

        issue_distribution: issueDist,
        faq_opportunities:  faqOpportunities,
      },
    });
  } catch (err) {
    console.error('[aiHubController] getAEOHubData error:', err, { projectId });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch AEO Hub data',
      error:   err.message,
    });
  }
};

// GET /api/aeo-hub/:projectId/issues/:ruleId
export const getAEOHubIssueDetail = async (req, res) => {
  const { projectId, ruleId } = req.params;

  try {
    const db  = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);

    const aiProjectDoc = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    if (!aiProjectDoc) {
      return res.json({ success: true, data: null });
    }

    const jobId = aiProjectDoc.job_id;

    const docs = await db.collection('ai_issues')
      .find({ project_id: pid, job_id: jobId, hub: 'aeo', rule_id: ruleId })
      .project({ url: 1, severity: 1, issue_title: 1, issue_description: 1, recommendation: 1, card: 1, evidence: 1 })
      .toArray();

    if (docs.length === 0) {
      return res.json({ success: true, data: null });
    }

    const first = docs[0];
    const faqMismatches = ruleId === 'AEO-048'
      ? [...new Set(docs.flatMap(d => d.evidence?.mismatches ?? []))]
      : [];

    return res.json({
      success: true,
      data: {
        rule_id:           ruleId,
        card:              first.card,
        issue_title:       first.issue_title,
        issue_description: first.issue_description,
        recommendation:    first.recommendation,
        severity:          first.severity,
        impact_score:      IMPACT_SCORES[first.severity] ?? 5,
        pages_affected:    docs.length,
        affected_urls:     docs.map(d => d.url),
        evidence:          first.evidence ?? {},
        faq_mismatches:    faqMismatches,
      },
    });
  } catch (err) {
    console.error('[aiHubController] getAEOHubIssueDetail error:', err, { projectId, ruleId });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch AEO issue detail',
      error:   err.message,
    });
  }
};

// GET /api/aeo-hub/:projectId/issues
export const getAEOHubIssues = async (req, res) => {
  const { projectId } = req.params;

  try {
    const db  = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);

    const aiProjectDoc = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    if (!aiProjectDoc) {
      return res.json({ success: true, data: { issues: [] } });
    }

    const jobId = aiProjectDoc.job_id;

    const pipeline = [
      { $match: { project_id: pid, job_id: jobId, hub: 'aeo' } },
      {
        $group: {
          _id:               '$rule_id',
          card:              { $first: '$card' },
          issue_title:       { $first: '$issue_title' },
          issue_description: { $first: '$issue_description' },
          recommendation:    { $first: '$recommendation' },
          severity:          { $first: '$severity' },
          pages_affected:    { $sum: 1 },
          affected_urls:     { $push: '$url' },
        },
      },
      { $sort: { pages_affected: -1 } },
    ];

    const rawIssues = await db.collection('ai_issues').aggregate(pipeline).toArray();

    const issues = rawIssues.map((issue) => ({
      rule_id:           issue._id,
      card:              issue.card,
      issue_title:       issue.issue_title,
      issue_description: issue.issue_description,
      recommendation:    issue.recommendation,
      severity:          issue.severity,
      impact_score:      IMPACT_SCORES[issue.severity] ?? 5,
      pages_affected:    issue.pages_affected,
      affected_urls:     issue.affected_urls.slice(0, 5),
    }));

    return res.json({ success: true, data: { issues } });
  } catch (err) {
    console.error('[aiHubController] getAEOHubIssues error:', err, { projectId });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch AEO Hub issues',
      error:   err.message,
    });
  }
};

// ── GEO Hub controllers ───────────────────────────────────────────────────────

const GEO_SIGNAL_META = {
  'GEO-059': { id: 'lb_schema',  label: 'LocalBusiness Schema' },
  'GEO-060': { id: 'geocoords',  label: 'Geo Coordinates'      },
  'GEO-061': { id: 'hours',      label: 'Opening Hours'        },
  'GEO-G1':  { id: 'nap',        label: 'NAP Consistency'      },
  'GEO-G2':  { id: 'same_as',    label: 'SameAs Links'         },
  'GEO-G3':  { id: 'org_schema', label: 'Aggregate Rating'     },
};

const GEO_SIGNAL_RULE_IDS = Object.keys(GEO_SIGNAL_META);

const GEO_KG_CARD_META = {
  entity_authority:      { label: 'Entity Authority Score',   subtitle: 'Global recognition ranking', accent: 'brand'     },
  knowledge_graph_score: { label: 'Knowledge Graph Score',    subtitle: 'Connectivity & relations',   accent: 'secondary' },
  brand_corroboration:   { label: 'Brand Corroboration',      subtitle: 'Third-party validation',     accent: 'cyan'      },
};

// Page types where LocalBusiness rules (GEO-059/060/061/062/063 and GEO-G1/G2/G3) apply.
// Mirrors _GEO_LB_SKIP in page_type_matrix.py — update both files when adding page types.
const GEO_LB_APPLICABLE_TYPES = ['homepage', 'contact', 'location', 'about'];

// All schema.org @type values that satisfy "Organization" via inheritance.
// Mirrors the Organization branch of schema_hierarchy.py — update both files together.
// Used in Q4 aggregation to detect Organization schema via $setIntersection on types_present.
const ORG_SUBTYPES = [
  // Direct Organization subtypes
  'Organization', 'Corporation', 'NGO', 'GovernmentOrganization',
  'EducationalOrganization', 'MedicalOrganization', 'NewsMediaOrganization',
  'OnlineBusiness', 'PerformingGroup', 'SportsOrganization',
  // LocalBusiness (Organization → LocalBusiness)
  'LocalBusiness', 'AutoDealer', 'HealthAndBeautyBusiness',
  'HomeAndConstructionBusiness', 'LodgingBusiness', 'EntertainmentBusiness',
  'FoodEstablishment', 'Store', 'FinancialService', 'SportsActivityLocation',
  'MedicalClinic', 'Dentist', 'LegalService', 'AnimalShelter',
  'ChildCare', 'DryCleaningOrLaundry', 'EmergencyService', 'EmploymentAgency',
  // HealthAndBeautyBusiness subtypes
  'HairSalon', 'BeautySalon', 'NailSalon', 'TattooParlor',
  // FoodEstablishment subtypes
  'Restaurant', 'CafeOrCoffeeShop', 'FastFoodRestaurant', 'Bakery', 'BarOrPub', 'IceCreamShop',
  // LodgingBusiness subtypes
  'BedAndBreakfast', 'Campground', 'Hostel', 'Hotel', 'Motel', 'Resort', 'VacationRental',
];

// Maps each GEO rule_id to its applicable page-type set.
//   'lb'     = GEO_LB_APPLICABLE_TYPES + generic pages where LB schema is present
//   'domain' = domain-scoped rule (one result for the whole site, not per page)
//   string[] = explicit list of applicable page types
const GEO_RULE_APPLICABLE_TYPES = {
  'GEO-059': 'lb', 'GEO-060': 'lb', 'GEO-061': 'lb',
  'GEO-062': 'lb', 'GEO-063': 'lb',
  'GEO-G1':  'lb', 'GEO-G2':  'lb', 'GEO-G3':  'lb',
  'GEO-065': 'domain',
  'GEO-S1':  ['service'],
  'GEO-S2':  ['article', 'blog'],
  'GEO-S3':  ['faq'],
  'GEO-S4':  ['product'],
  'GEO-S5':  ['about'],
};

function deriveEntityTrustGrade(score) {
  if (score >= 90) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 80) return 'A-';
  if (score >= 75) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 65) return 'B-';
  if (score >= 60) return 'C+';
  return 'C';
}

// GET /api/geo-hub/:projectId
export const getGEOHubData = async (req, res) => {
  const { projectId } = req.params;

  try {
    const db  = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);

    const aiProjectDoc = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    if (!aiProjectDoc) {
      return res.json({ success: true, data: null });
    }

    const jobId       = aiProjectDoc.job_id;
    const geo         = aiProjectDoc.hubs?.geo ?? {};
    const geoCards    = geo.cards ?? {};
    const pagesScored = aiProjectDoc.pages_scored ?? 1;

    const [severityRows, signalRows, opportunityDocs, schemaCoverageRows, lbApplicableResult] = await Promise.all([
      // Q1: GEO-only severity distribution
      db.collection('ai_issues').aggregate([
        { $match: { project_id: pid, job_id: jobId, hub: 'geo' } },
        { $group: { _id: '$severity', count: { $sum: 1 } } },
      ]).toArray(),

      // Q2: per-rule fail counts for validation signals
      db.collection('ai_issues').aggregate([
        { $match: { project_id: pid, job_id: jobId, hub: 'geo', rule_id: { $in: GEO_SIGNAL_RULE_IDS } } },
        { $group: { _id: '$rule_id', pages_failing: { $sum: 1 } } },
      ]).toArray(),

      // Q3: top GEO opportunities (distinct rules, sorted by pages_affected)
      db.collection('ai_issues').aggregate([
        { $match: { project_id: pid, job_id: jobId, hub: 'geo', rule_id: { $in: GEO_SIGNAL_RULE_IDS } } },
        { $group: {
            _id:            '$rule_id',
            issue_title:    { $first: '$issue_title' },
            severity:       { $first: '$severity' },
            recommendation: { $first: '$recommendation' },
            pages_affected: { $sum: 1 },
        }},
        { $sort: { pages_affected: -1 } },
        { $limit: 4 },
      ]).toArray(),

      // Q4: schema coverage per page type — reads ai_pages, not ai_issues
      // Maps each page to its expected schema based on page_type, then aggregates
      // applicable_pages / pages_with_schema per schema type.
      db.collection('ai_pages').aggregate([
        { $match: { project_id: pid, job_id: jobId } },
        // Determine which schema is expected for this page type
        { $addFields: {
            expected_schema: {
              $switch: {
                branches: [
                  { case: { $in: ['$page_type', ['homepage', 'contact', 'location']] }, then: 'LocalBusiness' },
                  { case: { $eq: ['$page_type', 'service']  }, then: 'Service'      },
                  { case: { $in: ['$page_type', ['article', 'blog']] }, then: 'Article' },
                  { case: { $eq: ['$page_type', 'faq']      }, then: 'FAQPage'      },
                  { case: { $eq: ['$page_type', 'product']  }, then: 'Product'      },
                  { case: { $eq: ['$page_type', 'about']    }, then: 'Organization' },
                ],
                default: null,
              },
            },
        }},
        // Only keep pages that have a defined expected schema
        { $match: { expected_schema: { $ne: null } } },
        // Determine whether the expected schema is present on this page
        { $addFields: {
            schema_present: {
              $switch: {
                branches: [
                  // LocalBusiness: use dedicated boolean (handles all LB subtypes)
                  {
                    case: { $eq: ['$expected_schema', 'LocalBusiness'] },
                    then: { $ifNull: ['$schema.local_business.present', false] },
                  },
                  // FAQPage: check types_present OR faq_schema_pairs has content
                  {
                    case: { $eq: ['$expected_schema', 'FAQPage'] },
                    then: {
                      $or: [
                        { $in: ['FAQPage', { $ifNull: ['$schema.types_present', []] }] },
                        { $gt: [{ $size: { $ifNull: ['$schema.faq_schema_pairs', []] } }, 0] },
                      ],
                    },
                  },
                  // Organization: hierarchy-aware check.
                  // Accepts Organization itself and any subtype (LocalBusiness,
                  // Restaurant, MedicalClinic, etc.) via $setIntersection on
                  // types_present against ORG_SUBTYPES. Falls back to the
                  // dedicated schema booleans for pages where types_present
                  // may not have been written (older audit documents).
                  {
                    case: { $eq: ['$expected_schema', 'Organization'] },
                    then: {
                      $or: [
                        { $ifNull: ['$schema.organization.present', false] },
                        { $ifNull: ['$schema.local_business.present', false] },
                        { $gt: [
                          { $size: {
                            $setIntersection: [
                              { $ifNull: ['$schema.types_present', []] },
                              ORG_SUBTYPES,
                            ],
                          }},
                          0,
                        ]},
                      ],
                    },
                  },
                ],
                // Service, Article, Product: check types_present list
                default: {
                  $in: ['$expected_schema', { $ifNull: ['$schema.types_present', []] }],
                },
              },
            },
        }},
        // Group by expected_schema, accumulate counts and missing URLs
        { $group: {
            _id:               '$expected_schema',
            applicable_pages:  { $sum: 1 },
            pages_with_schema: { $sum: { $cond: ['$schema_present', 1, 0] } },
            candidate_urls:    { $push: { $cond: ['$schema_present', null, '$url'] } },
        }},
        // Shape the final output
        { $project: {
            _id: 0,
            schema_type:          '$_id',
            applicable_pages:     1,
            pages_with_schema:    1,
            pages_missing_schema: { $subtract: ['$applicable_pages', '$pages_with_schema'] },
            coverage_percent: {
              $cond: {
                if:   { $eq: ['$applicable_pages', 0] },
                then: 0,
                else: {
                  $round: [{
                    $multiply: [
                      { $divide: ['$pages_with_schema', '$applicable_pages'] },
                      100,
                    ],
                  }, 1],
                },
              },
            },
            // Filter out null placeholders, cap at 20 URLs
            affected_urls: {
              $slice: [
                { $filter: { input: '$candidate_urls', cond: { $ne: ['$$this', null] } } },
                20,
              ],
            },
        }},
        // Worst coverage first
        { $sort: { coverage_percent: 1 } },
      ]).toArray(),

      // Q5: count pages where LocalBusiness rules are applicable
      // = known LB page types + generic pages that actually have LB schema present
      db.collection('ai_pages').aggregate([
        { $match: { project_id: pid, job_id: jobId } },
        { $match: {
          $or: [
            { page_type: { $in: GEO_LB_APPLICABLE_TYPES } },
            { page_type: { $in: ['generic', null] }, 'schema.local_business.present': true },
          ],
        }},
        { $count: 'n' },
      ]).toArray(),
    ]);

    const lbApplicablePages = lbApplicableResult[0]?.n ?? 0;

    // ── Issue distribution ───────────────────────────────────────────────────
    const issueDist = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    for (const { _id, count } of severityRows) {
      if (_id in issueDist) {
        issueDist[_id]   = count;
        issueDist.total += count;
      }
    }

    // ── Validation signals ───────────────────────────────────────────────────
    const failMap = {};
    for (const { _id, pages_failing } of signalRows) failMap[_id] = pages_failing;

    const validation = Object.entries(GEO_SIGNAL_META).map(([ruleId, meta]) => {
      const pagesFailing = failMap[ruleId] ?? 0;
      // Verified against all 18 real ai_projects in the dev DB: this never
      // fires for the 'lb'-mapped signal rules today (unlike GEO-S1..S5
      // below, which do). Kept as a guard rail rather than removed, since
      // Math.max(0, ...) would otherwise silently absorb a future
      // inconsistency into a plausible-looking but wrong 0-pages-passed
      // result with no trace of why.
      if (pagesFailing > lbApplicablePages) {
        console.warn(
          `[aiHubController] Impossible state: pages_failing (${pagesFailing}) > lbApplicablePages (${lbApplicablePages}) for signal rule ${ruleId}`,
          { projectId }
        );
      }
      const passedPages  = Math.max(0, lbApplicablePages - pagesFailing);
      const score = lbApplicablePages > 0
        ? Math.round((passedPages / lbApplicablePages) * 100)
        : 0;
      const status = score >= 70 ? 'pass' : score >= 40 ? 'warning' : 'fail';
      const description = status === 'pass'
        ? `Validated on ${passedPages} / ${lbApplicablePages} applicable pages`
        : status === 'warning'
          ? `${pagesFailing} of ${lbApplicablePages} applicable pages need updates`
          : `Missing on ${pagesFailing} of ${lbApplicablePages} applicable pages`;
      return {
        id:               meta.id,
        label:            meta.label,
        status,
        description,
        pages_failing:    pagesFailing,
        passed_pages:     passedPages,
        applicable_pages: lbApplicablePages,
        score,
      };
    });

    // ── Knowledge graph cards ────────────────────────────────────────────────
    const knowledgeGraphCards = Object.entries(GEO_KG_CARD_META).map(([key, meta]) => {
      const raw = geoCards[key] ?? {};
      return {
        id:       key,
        label:    meta.label,
        subtitle: meta.subtitle,
        accent:   meta.accent,
        score:    Math.round(raw.score       ?? 0),
        passed:   raw.total_passed ?? 0,
        failed:   raw.total_failed ?? 0,
      };
    });

    // ── Hero cards (3 cards — geo_readiness excluded) ───────────────────────
    const HERO_CARD_KEYS = ['entity_authority', 'knowledge_graph_score', 'brand_corroboration'];
    const heroCards = {};
    for (const key of HERO_CARD_KEYS) {
      const raw = geoCards[key] ?? {};
      heroCards[key] = { score: Math.round(raw.score ?? 0), trend: 'stable', trend_dir: 'stable' };
    }

    // ── Opportunities ────────────────────────────────────────────────────────
    const geoScore = Math.round(geo.score ?? 0);
    const opportunities = opportunityDocs.map((doc, i) => ({
      id:          `opp-${i + 1}`,
      priority:    doc.severity ?? 'medium',
      title:       doc.issue_title,
      description: doc.recommendation ?? '',
    }));

    return res.json({
      success: true,
      data: {
        project_id:   projectId,
        job_id:       jobId,
        pages_scored: pagesScored,
        computed_at:  aiProjectDoc.computed_at,
        geo_score:    geoScore,
        score_trend:  null,

        hero: {
          geo_score: geoScore,
          cards:     heroCards,
        },

        validation,
        knowledge_graph_cards: knowledgeGraphCards,
        issue_distribution:    issueDist,

        entity_trust_score: deriveEntityTrustGrade(geoScore),
        validated_entities: Math.max(0, lbApplicablePages - (failMap['GEO-059'] ?? 0)),
        missing_links:      failMap['GEO-G2'] ?? 0,

        schema_coverage: schemaCoverageRows,

        opportunities,
      },
    });
  } catch (err) {
    console.error('[aiHubController] getGEOHubData error:', err, { projectId });
    return res.status(500).json({ success: false, message: 'Failed to fetch GEO Hub data', error: err.message });
  }
};

// GET /api/geo-hub/:projectId/issues
export const getGEOHubIssues = async (req, res) => {
  const { projectId } = req.params;

  try {
    const db  = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);

    const aiProjectDoc = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    if (!aiProjectDoc) {
      return res.json({ success: true, data: { issues: [] } });
    }

    const jobId = aiProjectDoc.job_id;

    const rawIssues = await db.collection('ai_issues').aggregate([
      { $match: { project_id: pid, job_id: jobId, hub: 'geo' } },
      { $group: {
          _id:               '$rule_id',
          card:              { $first: '$card' },
          issue_title:       { $first: '$issue_title' },
          issue_description: { $first: '$issue_description' },
          recommendation:    { $first: '$recommendation' },
          severity:          { $first: '$severity' },
          pages_affected:    { $sum: 1 },
          affected_urls:     { $push: '$url' },
      }},
      { $sort: { pages_affected: -1 } },
    ]).toArray();

    // Count pages per type + generic LB pages to compute applicable_pages per rule
    const [pageTypeCounts, genericLBCount] = await Promise.all([
      db.collection('ai_pages').aggregate([
        { $match: { project_id: pid, job_id: jobId } },
        { $group: { _id: '$page_type', count: { $sum: 1 } } },
      ]).toArray(),
      db.collection('ai_pages').countDocuments({
        project_id: pid,
        job_id:     jobId,
        page_type:  { $in: ['generic', null] },
        'schema.local_business.present': true,
      }),
    ]);

    const typeMap = {};
    for (const { _id, count } of pageTypeCounts) typeMap[_id ?? 'generic'] = count;
    const lbApplicable = GEO_LB_APPLICABLE_TYPES.reduce((s, t) => s + (typeMap[t] ?? 0), 0) + genericLBCount;

    const getApplicable = (ruleId) => {
      const rule = GEO_RULE_APPLICABLE_TYPES[ruleId];
      if (rule === undefined || rule === 'domain') return null;
      if (rule === 'lb') return lbApplicable;
      return rule.reduce((s, t) => s + (typeMap[t] ?? 0), 0);
    };

    const issues = rawIssues.map(issue => ({
      rule_id:           issue._id,
      card:              issue.card,
      issue_title:       issue.issue_title,
      issue_description: issue.issue_description,
      recommendation:    issue.recommendation,
      severity:          issue.severity,
      impact_score:      IMPACT_SCORES[issue.severity] ?? 5,
      pages_affected:    issue.pages_affected,
      applicable_pages:  guardApplicablePages(issue.pages_affected, getApplicable(issue._id), { projectId, rule_id: issue._id }),
      affected_urls:     issue.affected_urls.slice(0, 5),
    }));

    return res.json({ success: true, data: { issues } });
  } catch (err) {
    console.error('[aiHubController] getGEOHubIssues error:', err, { projectId });
    return res.status(500).json({ success: false, message: 'Failed to fetch GEO Hub issues', error: err.message });
  }
};

// GET /api/geo-hub/:projectId/issues/:ruleId
export const getGEOHubIssueDetail = async (req, res) => {
  const { projectId, ruleId } = req.params;

  try {
    const db  = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);

    const aiProjectDoc = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    if (!aiProjectDoc) {
      return res.json({ success: true, data: null });
    }

    const jobId = aiProjectDoc.job_id;

    const docs = await db.collection('ai_issues')
      .find({ project_id: pid, job_id: jobId, hub: 'geo', rule_id: ruleId })
      .project({ url: 1, severity: 1, issue_title: 1, issue_description: 1, recommendation: 1, card: 1, evidence: 1 })
      .toArray();

    if (docs.length === 0) {
      return res.json({ success: true, data: null });
    }

    const first = docs[0];
    return res.json({
      success: true,
      data: {
        rule_id:           ruleId,
        card:              first.card,
        issue_title:       first.issue_title,
        issue_description: first.issue_description,
        recommendation:    first.recommendation,
        severity:          first.severity,
        impact_score:      IMPACT_SCORES[first.severity] ?? 5,
        pages_affected:    docs.length,
        affected_urls:     docs.map(d => d.url),
        evidence:          first.evidence ?? {},
      },
    });
  } catch (err) {
    console.error('[aiHubController] getGEOHubIssueDetail error:', err, { projectId, ruleId });
    return res.status(500).json({ success: false, message: 'Failed to fetch GEO issue detail', error: err.message });
  }
};

// GET /api/aiso-hub/:projectId/issues
export const getAISOHubIssues = async (req, res) => {
  const { projectId } = req.params;

  try {
    const db  = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);

    const aiProjectDoc = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    if (!aiProjectDoc) {
      return res.json({ success: true, data: { issues: [] } });
    }

    const jobId = aiProjectDoc.job_id;

    const pipeline = [
      { $match: { project_id: pid, job_id: jobId, hub: 'aiso' } },
      {
        $group: {
          _id:               '$rule_id',
          card:              { $first: '$card' },
          scope:             { $first: '$scope' },
          issue_title:       { $first: '$issue_title' },
          issue_description: { $first: '$issue_description' },
          recommendation:    { $first: '$recommendation' },
          severity:          { $first: '$severity' },
          pages_affected:    { $sum: 1 },
          affected_urls:     { $push: '$url' },
        },
      },
      { $sort: { pages_affected: -1 } },
    ];

    const rawIssues = await db.collection('ai_issues').aggregate(pipeline).toArray();

    const issues = rawIssues.map((issue) => {
      const isDomain = (issue.scope ?? 'page') === 'domain';
      return {
        rule_id:           issue._id,
        card:              issue.card,
        scope:             issue.scope ?? 'page',
        issue_title:       issue.issue_title,
        issue_description: issue.issue_description,
        recommendation:    issue.recommendation,
        severity:          issue.severity,
        impact_score:      IMPACT_SCORES[issue.severity] ?? 5,
        pages_affected:    isDomain ? null : issue.pages_affected,
        affected_scope:    isDomain ? 'Entire Website' : null,
        affected_urls:     isDomain ? [] : issue.affected_urls.slice(0, 5),
      };
    });

    return res.json({ success: true, data: { issues } });
  } catch (err) {
    console.error('[aiHubController] getAISOHubIssues error:', err, { projectId });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch AISO Hub issues',
      error:   err.message,
    });
  }
};

// ── Hub → IssueRow category label ────────────────────────────────────────────
const HUB_CATEGORY = { aiso: 'AISEO', aeo: 'AEO', geo: 'GEO' };

// GET /api/ai-pages/:projectId/issues?url=<encoded>
export const getPageAIIssues = async (req, res) => {
  const { projectId } = req.params;
  const rawUrl = req.query.url;

  if (!rawUrl) {
    return res.status(400).json({ success: false, message: '`url` query parameter is required' });
  }

  try {
    const db  = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);
    const url = decodeURIComponent(rawUrl);

    const aiProjectDoc = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    if (!aiProjectDoc) {
      return res.json({ success: true, data: { issues: [], page_data: {}, page_metadata: {} } });
    }

    const jobId = aiProjectDoc.job_id;

    const [issueDocs, aiPage] = await Promise.all([
      db.collection('ai_issues')
        .find({ project_id: pid, job_id: jobId, url })
        .project({ hub: 1, rule_id: 1, severity: 1, issue_title: 1, issue_description: 1, recommendation: 1 })
        .toArray(),

      db.collection('ai_pages').findOne(
        { project_id: pid, job_id: jobId, url },
        {
          projection: {
            'meta.title':             1,
            'meta.description':       1,
            'title':                  1,
            'meta_description':       1,
            'crawlability.status_code': 1,
            'status_code':            1,
            'word_count':             1,
            'response_time':          1,
          },
        },
      ),
    ]);

    const issues = issueDocs.map((doc) => ({
      id:          doc.rule_id,
      title:       doc.issue_title,
      description: doc.issue_description,
      severity:    doc.severity,
      category:    HUB_CATEGORY[doc.hub] ?? 'AISEO',
      recommendation: doc.recommendation,
    }));

    const page_data = {
      title:            aiPage?.meta?.title       || aiPage?.title            || '',
      meta_description: aiPage?.meta?.description || aiPage?.meta_description || '',
      status_code:      aiPage?.crawlability?.status_code ?? aiPage?.status_code ?? 200,
      word_count:       aiPage?.word_count        ?? 0,
      response_time:    aiPage?.response_time     ?? 0,
    };

    return res.json({ success: true, data: { issues, page_data, page_metadata: {} } });
  } catch (err) {
    console.error('[aiHubController] getPageAIIssues error:', err, { projectId, url: rawUrl });
    return res.status(500).json({ success: false, message: 'Failed to fetch page AI issues', error: err.message });
  }
};
