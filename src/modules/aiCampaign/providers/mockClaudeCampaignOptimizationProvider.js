/**
 * MockClaudeCampaignOptimizationProvider — test double for
 * ClaudeCampaignOptimizationProvider. Same interface (`isAvailable`,
 * `generateRecommendations`, `retryDelayFor`), zero network.
 * campaignOptimizationService accepts a `provider` argument so every test
 * injects one of these — no test may ever reach the real Anthropic API
 * (spec §44 analogue for Phase 7).
 */
export class MockClaudeCampaignOptimizationProvider {
  constructor(opts = {}) {
    this.opts = opts;
    this.calls = [];
    this._available = opts.available !== false;
  }

  isAvailable() {
    return this._available;
  }

  retryDelayFor() {
    return null;
  }

  async generateRecommendations(args) {
    this.calls.push({ system: args?.system, user: args?.user, generationId: args?.generationId });

    if (this.opts.error) {
      if (this.opts.error instanceof Error) throw this.opts.error;
      const err = new Error(String(this.opts.error));
      err.code = String(this.opts.error);
      err.provider = 'CLAUDE';
      throw err;
    }

    const parsed = this.opts.parsedFactory ? this.opts.parsedFactory(args) : this.opts.parsed;
    if (parsed === undefined) {
      const err = new Error('CLAUDE_BAD_OUTPUT');
      err.code = 'CLAUDE_BAD_OUTPUT';
      throw err;
    }

    return {
      parsed,
      usage: this.opts.usage || { inputTokens: 210, outputTokens: 180 },
      model: this.opts.model || 'mock-claude-optimization',
      stopReason: 'tool_use',
      durationMs: 3,
      attempts: 1,
    };
  }
}

export default MockClaudeCampaignOptimizationProvider;
