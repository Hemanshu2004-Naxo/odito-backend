/**
 * Test fixtures for the Social AI Strategy: a VALID raw model output (what the
 * forced tool call would return) and a controllable mock provider. Test-only —
 * nothing here is used at runtime and none of it is a fallback for real output.
 */

export function validRawStrategy(overrides = {}) {
  return {
    summary: 'Build local trust with practical dental education and real patient-facing offers on Facebook and Instagram.',
    overview: {
      primaryObjective: 'Trust and new patient bookings',
      strongestOpportunity: 'Educational content that calms dental anxiety',
      growthOpportunity: 'Consistent proof and team-led content',
      platformFocus: 'Facebook for community, Instagram for visual storytelling',
    },
    brandAnalysis: {
      strengths: ['Clear family-dentistry focus', 'Open late on weekdays'],
      weaknesses: ['Little proof content so far'],
      differentiators: ['Gentle, explain-everything approach'],
      personality: ['Warm', 'Reassuring', 'Professional'],
      communicationStyle: 'Plain, friendly language that explains rather than sells.',
      opportunities: ['More educational authority content', 'Stronger CTA consistency'],
      risks: ['Generic dental messaging', 'Too many promotional posts'],
    },
    positioning: {
      brandPositioning: 'A friendly neighbourhood dental practice that explains things clearly.',
      valueProposition: 'Clear, gentle dental care for local families.',
      keyDifferentiators: ['Open late on weekdays', 'Free first check-up'],
      whyCustomersChoose: 'Gentle care, clear explanations and convenient hours.',
      messagingAngle: 'Nothing to be nervous about.',
    },
    audience: {
      primaryAudience: 'Young families nearby',
      secondaryAudiences: ['Retirees'],
      painPoints: ['Nervous about dental visits'],
      needs: ['Convenient appointment times'],
      motivations: ['Keeping the family healthy'],
      buyingTriggers: ['A child needs a check-up'],
      objections: ['Worried about cost'],
      interests: ['Family health'],
    },
    goals: [{ goal: 'More bookings', priority: 'high', rationale: 'Supplied by the business as the main goal.' }],
    contentPillars: [
      { name: 'Dental tips', description: 'Simple everyday care advice.', purpose: 'Build trust', suggestedPercentage: 50, exampleTopics: ['Brushing basics'], formats: ['Carousel', 'Reel'] },
      { name: 'Meet the team', description: 'The people behind the practice.', purpose: 'Reduce anxiety', suggestedPercentage: 30, exampleTopics: ['Team introductions'], formats: ['Static post'] },
      { name: 'Offers', description: 'Current offers.', purpose: 'Drive bookings', suggestedPercentage: 20, exampleTopics: ['Free check-up'], formats: ['Static post'] },
    ],
    contentMix: [
      { type: 'educational', percentage: 50, rationale: 'Trust first.' },
      { type: 'behind_the_scenes', percentage: 30, rationale: 'Humanise the practice.' },
      { type: 'soft_sell', percentage: 20, rationale: 'Gentle conversion.' },
    ],
    trendingTopics: [
      { topic: 'Back-to-school dental check-ups', whyItMatters: 'Parents book check-ups before term starts.', relevance: 'high', angle: 'A calm checklist for a child\'s first visit', freshness: 'seasonal' },
    ],
    workingHooks: [
      { hook: 'Most people brush too hard. Here is the fix.', category: 'educational' },
      { hook: 'Nervous about the dentist? Start here.', category: 'problem_solution' },
      { hook: 'What really happens at a first check-up?', category: 'curiosity' },
      { hook: 'Floss every day? You may still be missing this.', category: 'contrarian' },
      { hook: 'Meet the person who makes visits easier.', category: 'story' },
      { hook: 'Three questions to ask before your next appointment.', category: 'engagement' },
    ],
    competitorAnalysis: { competitorsConsidered: [], differentiationOpportunities: [], contentGaps: [], recommendations: [] },
    platformStrategy: [
      { platform: 'facebook', role: 'Community and offers', contentTypes: ['Photo posts', 'Event posts'], postsPerWeek: 3, audienceBehavior: 'Local families look for trusted practices.', guidance: ['Lead with a clear local benefit'] },
      { platform: 'instagram', role: 'Visual storytelling', contentTypes: ['Reels', 'Carousels'], postsPerWeek: 3, audienceBehavior: 'Visual, quick to scan.', guidance: ['Use a strong first frame'] },
    ],
    toneAndVoice: { primaryTone: 'Warm and professional', secondaryTones: ['Reassuring'], writingGuidelines: ['Plain language'], avoid: ['Jargon'] },
    postingStrategy: { postsPerWeek: 4, postsPerWeekRange: { min: 3, max: 5 }, recommendedDays: ['tuesday', 'thursday', 'saturday'], recommendedTimeWindows: ['Early evening'] },
    hashtagStrategy: { enabled: true, approach: 'A few local and topical tags.', recommendedCount: 5, categories: ['Local', 'Dental health'] },
    ctaStrategy: {
      preferredCTAs: ['Book a check-up'],
      objectives: ['Bookings'],
      byObjective: [
        { objective: 'awareness', ctas: ['Follow for more tips'] },
        { objective: 'engagement', ctas: ['Save this', 'Comment below'] },
        { objective: 'lead_generation', ctas: ['Book a check-up'] },
      ],
    },
    brandRules: { visualGuidelines: ['Bright, clean photography'], messagingRules: ['Explain, never scare'] },
    recommendations: ['Post consistently for 8 weeks before judging results.'],
    planOutlook: {
      seasonalThemes: [{ theme: 'Back-to-school check-ups', timing: 'Month 1', idea: 'Remind families to book a check-up before the term gets busy.' }],
      campaignIdeas: [{ name: 'Smile check week', idea: 'A week of short tips ending with an invitation to book a check-up.' }],
      successMetrics: [{ metric: 'Booking enquiries', whatGoodLooks: 'More messages asking to book after educational posts.' }],
    },
    assumptions: [],
    gaps: [],
    ...overrides,
  };
}

/**
 * A provider whose calls can be scripted. `behavior` is called with the prompt
 * and must return a raw strategy (or throw). `gate` lets a test hold the call
 * open to exercise duplicate / concurrent generation.
 */
export function mockProvider({ behavior = () => validRawStrategy(), available = true, gate = null } = {}) {
  const calls = [];
  return {
    calls,
    isAvailable: () => available,
    async generateStrategy({ system, user, generationId }) {
      calls.push({ system, user, generationId });
      if (gate) await gate;
      const parsed = await behavior({ system, user, callNumber: calls.length });
      return { parsed, usage: { inputTokens: 100, outputTokens: 200 }, model: 'mock-model', durationMs: 5, attempts: 1 };
    },
  };
}

export function providerError(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// ── single-post AI content ────────────────────────────────────────────────

/** A VALID raw post as the forced tool call would return it (matches the strategy fixture's first pillar / educational objective). */
export function validRawPost(overrides = {}) {
  return {
    platform: 'facebook',
    contentPillar: 'Dental tips',
    objective: 'educational',
    caption: 'Brushing for two minutes twice a day is still the simplest way to protect your smile. Not sure your technique is right? Book a check-up and we will show you.',
    callToAction: 'Book a check-up',
    hashtags: ['#DentalCare', '#HealthySmile'],
    rationale: 'A practical tip for the Dental tips pillar, ending with the preferred booking call to action.',
    ...overrides,
  };
}

/** Same idea as mockProvider, with the content provider interface (generateContent). */
export function mockContentProvider({ behavior = () => validRawPost(), available = true, gate = null } = {}) {
  const calls = [];
  return {
    calls,
    isAvailable: () => available,
    async generateContent({ system, user, generationId }) {
      calls.push({ system, user, generationId });
      if (gate) await gate;
      const parsed = await behavior({ system, user, callNumber: calls.length });
      return { parsed, usage: { inputTokens: 50, outputTokens: 120 }, model: 'mock-content-model', durationMs: 5, attempts: 1 };
    },
  };
}

// ── content calendar planning ─────────────────────────────────────────────

/** The slots a calendar planning prompt asks for, parsed back out of its `<slots_to_plan>` block. */
export function parseSlotsFromPrompt(user) {
  const block = /<slots_to_plan>\n([\s\S]*?)\n<\/slots_to_plan>/.exec(user)?.[1] || '';
  return block.split('\n').map((l) => /^slot (\d+): (\d{4}-\d{2}-\d{2}) \((\w+)\) \| pillar: (.*?) \| platforms: (.*)$/.exec(l)).filter(Boolean).map((m) => ({
    index: Number(m[1]), date: m[2], dayOfWeek: m[3], pillar: m[4],
    fixedPlatforms: m[5].endsWith('(fixed)') ? m[5].replace(' (fixed)', '').split(', ') : null,
    choices: m[5].startsWith('choose from ') ? m[5].replace('choose from ', '').split(', ') : null,
  }));
}

/** One VALID raw calendar item for a slot (matches the strategy fixture: educational is in its content mix, hook 0..5 exist). */
export function validRawCalendarItem(slot, overrides = {}) {
  const platforms = overrides.platforms || slot.fixedPlatforms || [slot.choices?.[0] || 'facebook'];
  return {
    slot: slot.index,
    platforms,
    // the written copy: a shared caption + hashtags, and one adapted version per platform when the slot targets both
    caption: 'Brushing well is the simplest way to protect your smile.\n\nNot sure your technique is right? Save this post and ask us at your next visit.',
    hashtags: ['#DentalCare', '#HealthySmile'],
    platformContent: platforms.length > 1 ? platforms.map((platform) => ({ platform, caption: `A short ${platform} caption about brushing well. Save this for later.`, primaryCta: 'Save this', hashtags: ['#DentalCare'] })) : [],
    format: 'static_post',
    deliverable: 'Educational post',
    contentType: 'educational',
    objective: 'engagement',
    primaryKpi: 'saves',
    targetAudience: 'Young families',
    occasion: '',
    topic: `Planned topic number ${slot.index + 1}`,
    angle: 'A practical, reassuring angle',
    hook: '',
    hookRef: slot.index % 6,
    onCreativeText: '',
    creativeDirection: 'Clean, bright photo of the clinic',
    contentBrief: 'Explain one simple habit in plain language.',
    captionDirection: 'Warm, plain language, one clear takeaway.',
    primaryCta: 'Save this',
    engagementPrompt: 'What would you like us to cover next?',
    requiredAssets: [],
    serviceId: null,
    productId: null,
    requiresReview: false,
    approvalNotes: '',
    footerDisclaimer: '',
    ...overrides,
  };
}

/** A VALID raw batch for the slots in a prompt. `perItem(slot)` can return overrides for any item. */
export function validRawCalendarBatch(slots, perItem = () => ({})) {
  return { items: slots.map((slot) => validRawCalendarItem(slot, perItem(slot) || {})) };
}

/**
 * Same idea as mockProvider, with the calendar planning interface (generateCalendarPlan). By default it answers every
 * batch with a valid plan for exactly the slots in the prompt. `behavior({ slots, user, callNumber, schema })` may
 * return anything (or throw) to exercise validation, repair and failure paths. `gate` holds the call open.
 */
export function mockCalendarProvider({ behavior = null, available = true, gate = null } = {}) {
  const calls = [];
  return {
    calls,
    isAvailable: () => available,
    async generateCalendarPlan({ system, user, schema }) {
      const slots = parseSlotsFromPrompt(user);
      calls.push({ system, user, schema, slots });
      if (gate) await gate;
      const parsed = behavior ? await behavior({ slots, user, schema, callNumber: calls.length }) : validRawCalendarBatch(slots);
      return { parsed, usage: { inputTokens: 300, outputTokens: 900 }, model: 'mock-calendar-model', durationMs: 5, attempts: 1 };
    },
  };
}
