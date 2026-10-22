/**
 * Narration Generator Service
 * Uses deterministic templates to generate professional video narration scripts
 * Replaces AI-based generation for consistent, reliable output
 */

export class NarrationGeneratorService {
  /**
   * Generate a professional narration script from audit data
   * Uses template-based approach for consistent, human-like output
   * 
   * @param {Object} auditSnapshot - Audit data snapshot
   * @returns {string} Generated narration script
   */
  static generateNarrationScript(auditSnapshot) {
    try {
      console.log('[NARRATION_GEN] Generating script from audit snapshot');
      
      // Extract data from audit snapshot
      const scriptData = this.extractScriptData(auditSnapshot);
      
      // Generate script using template system
      const script = this.buildScript(scriptData);
      
      console.log('[NARRATION_GEN] Script generated successfully');
      return script;
      
    } catch (error) {
      console.error('[NARRATION_GEN] Error generating script:', error);
      throw new Error(`Script generation failed: ${error.message}`);
    }
  }

  /**
   * Extract relevant data from audit snapshot for script generation
   */
  static extractScriptData(auditSnapshot) {
    return {
      projectName: auditSnapshot.projectName || 'Your Website',
      scores: {
        overall: auditSnapshot.scores?.overall || 0,
        performance: auditSnapshot.scores?.performance || auditSnapshot.scores?.pageSpeed || 0,
        seo: auditSnapshot.scores?.seo || auditSnapshot.scores?.seoHealth || 0,
        aiVisibility: auditSnapshot.aiHubSnapshot?.overallScore ?? auditSnapshot.scores?.aiVisibility ?? 0
      },
      topIssues: {
        high: this.formatIssues(auditSnapshot.topIssues?.high || []),
        medium: this.formatIssues(auditSnapshot.topIssues?.medium || []),
        low: this.formatIssues(auditSnapshot.topIssues?.low || [])
      },
      performanceMetrics: {
        mobileScore: auditSnapshot.performanceMetrics?.mobileScore || 0,
        desktopScore: auditSnapshot.performanceMetrics?.desktopScore || 0,
        lcp: auditSnapshot.performanceMetrics?.metrics?.[0]?.mobile || '5.1',
        tbt: auditSnapshot.performanceMetrics?.metrics?.[1]?.mobile || '1960'
      },
      issueDistribution: auditSnapshot.issueDistribution || {},
      // Add keyword data for dynamic narration
      keywordData: auditSnapshot.keywordData || {
        totalKeywords: 0,
        topRankings: [],
        opportunities: [],
        notRanking: []
      }
    };
  }

  /**
   * Format issues array for natural language processing
   */
  static formatIssues(issues) {
    if (!Array.isArray(issues)) return [];
    return issues.map(issue => {
      if (typeof issue === 'string') return issue;
      return issue?.issue || issue?.title || issue?.name || issue?.detail || 'technical issue';
    }).filter(Boolean);
  }

  /**
   * Build complete script using template system
   */
  static buildScript(data) {
    const script = [
      this.generateIntro(data.projectName),
      this.generatePerformanceOverview(data.scores.overall),
      this.generateKeyIssues(data.topIssues.high, data.topIssues.medium),
      this.generateKeywordInsights(data.keywordData),
      this.generatePerformanceInsights(data.scores, data.performanceMetrics),
      this.generateAIVisibility(data.scores.aiVisibility),
      this.generateActionPlan(),
      this.generateClosing()
    ];

    return script.join('\n\n');
  }

  /**
   * Generate engaging introduction
   */
  static generateIntro(companyName) {
    return `Every successful digital presence starts with understanding exactly where you stand, and that's precisely what we're uncovering today for ${companyName || 'your website'}. Think of this analysis as your digital roadmap—a clear view into how your online presence is performing in real-world conditions, what opportunities you might be missing, and most importantly, how your website is actually serving the people who visit it every day. This isn't just about numbers and technical metrics; it's about the story your website tells to potential customers and how effectively that story converts visitors into loyal clients.`;
  }

  /**
   * Generate overall performance explanation
   */
  static generatePerformanceOverview(overallScore) {
    const scoreLevel = this.getScoreLevel(overallScore);
    return `When we look at your overall performance score of ${overallScore}, what we're really seeing is ${scoreLevel}. This score represents the culmination of countless factors working together—from how quickly your pages load to how easily search engines can understand and rank your content. At the same time, this number tells us something crucial about your competitive position in the digital marketplace. Because search engines and users alike increasingly demand fast, seamless experiences, this score directly impacts your ability to attract and retain customers in an environment where attention spans are shorter than ever and first impressions happen in milliseconds.`;
  }

  /**
   * Generate key issues discussion
   */
  static generateKeyIssues(highIssues, mediumIssues) {
    let issuesText = `The technical challenges we've identified are creating real friction in your customer journey, and each one represents a barrier between your business and potential success. When visitors encounter slow-loading pages or struggle to navigate your content, they don't just get frustrated—they leave, often never to return. As a result, these issues directly impact your bottom line through lost conversions and diminished search visibility. `;
    
    if (highIssues.length > 0) {
      issuesText += `Your high-priority concerns include ${this.joinWithConjunction(highIssues)}. These aren't just technical problems; they're actively working against your business goals by creating poor user experiences that search engines penalize. `;
    }
    
    if (mediumIssues.length > 0) {
      issuesText += `Additionally, we've identified medium-priority areas including ${this.joinWithConjunction(mediumIssues)}. While less critical, these issues compound over time and can gradually erode your competitive advantage if left unaddressed. `;
    }
    
    return issuesText + `The good news is that each of these challenges has a clear solution path, and addressing them systematically will create a compounding positive effect on your overall digital performance.`;
  }

  /**
   * Generate performance metrics explanation
   */
  static generatePerformanceInsights(scores, performanceMetrics) {
    const mobileScore = performanceMetrics.mobileScore || scores.performance;
    const desktopScore = performanceMetrics.desktopScore || scores.performance;
    const lcp = performanceMetrics.lcp || '5.1';
    const tbt = performanceMetrics.tbt || '1960';
    
    return `Your performance metrics tell a fascinating story about how users actually experience your website across different devices. With a mobile score of ${mobileScore} and desktop score of ${desktopScore}, we can see how your digital presence adapts to different user contexts—and where those adaptations might be falling short. The ${lcp}-second loading time for your main content might seem acceptable on paper, but in reality, users form impressions about your brand in the first three seconds. Because of this, every millisecond counts when it comes to keeping visitors engaged. At the same time, ${tbt} milliseconds of input delay means users are experiencing noticeable lag when interacting with your site, which directly impacts their perception of your professionalism and attention to detail. These metrics aren't just technical measurements—they're moments that either build or break trust with potential customers.`;
  }

  /**
   * Generate AI visibility discussion
   */
  static generateAIVisibility(aiVisibilityScore) {
    const level = aiVisibilityScore >= 70 ? 'strong' : aiVisibilityScore >= 40 ? 'developing' : 'critical';
    const levelDetail = aiVisibilityScore >= 70
      ? 'AI search agents, answer engines, and generative AI tools can discover, trust, and cite your content reliably'
      : aiVisibilityScore >= 40
      ? 'AI systems can partially access your content, but gaps in crawlability, answer structure, and entity trust are limiting your reach'
      : 'significant barriers are preventing AI systems from discovering, understanding, and citing your content';
    return `Your AI Visibility score is ${aiVisibilityScore} out of 100 — a ${level} position. Measured across three hubs: AI Search Optimization, which governs how AI crawlers access your content; Answer Engine Optimization, which determines how AI assistants extract and deliver your answers; and Generative Engine Optimization, which controls how much generative AI engines trust and feature your entity. At ${aiVisibilityScore}, ${levelDetail}. Improving this score directly expands your presence across ChatGPT, Gemini, Claude, Perplexity, and Google AI Overviews.`;
  }

  /**
   * Generate action plan
   */
  static generateActionPlan() {
    return `Your path forward requires a strategic approach that balances immediate wins with foundational improvements. We recommend starting with performance optimizations that will immediately enhance user experience, because these create the quickest positive impact on both visitor satisfaction and search rankings. At the same time, addressing technical SEO issues will remove barriers that prevent search engines from properly indexing and understanding your content. As you implement these changes, you'll notice a compounding effect—each improvement builds upon the previous one, creating momentum that accelerates your progress. The key is consistency and prioritization; focus on the changes that will deliver the greatest return on investment first, then systematically work through your optimization roadmap. This methodical approach ensures you're not just fixing problems, but building a stronger digital foundation that supports sustainable growth.`;
  }

  /**
   * Generate closing statement
   */
  static generateClosing() {
    return `Your website audit represents more than just a technical analysis—it's your blueprint for digital excellence and competitive advantage. Because the digital landscape continues to evolve at an unprecedented pace, the insights we've uncovered today provide you with the knowledge needed to make strategic decisions that drive measurable business results. Every improvement you implement creates lasting value that compounds over time, positioning your business not just to compete, but to lead in your industry. The opportunities before you are significant, and the path forward is clear. Your commitment to continuous improvement and digital excellence will set you apart in an increasingly crowded marketplace, ensuring your website becomes not just a digital presence, but a powerful engine for business growth and customer success.`;
  }

  /**
   * Get descriptive score level for natural language
   */
  static getScoreLevel(score) {
    if (typeof score !== 'number') return 'a moderate position that needs attention';
    if (score >= 90) return 'an exceptional performance that sets you apart from competitors';
    if (score >= 80) return 'a strong position with room for fine-tuning';
    if (score >= 70) return 'a solid foundation with clear opportunities for improvement';
    if (score >= 60) return 'a moderate position that requires strategic focus';
    if (score >= 50) return 'significant opportunities for growth and optimization';
    return 'critical areas that need immediate attention and strategic overhaul';
  }

  /**
   * Format score for natural language description
   */
  static formatScore(score) {
    if (typeof score !== 'number') return 'moderate';
    if (score >= 90) return 'excellent';
    if (score >= 80) return 'very good';
    if (score >= 70) return 'good';
    if (score >= 60) return 'moderate';
    if (score >= 50) return 'below average';
    return 'poor';
  }

  /**
   * Join array with natural conjunctions
   */
  static joinWithConjunction(items) {
    if (!items || items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  }

  /**
   * Generate keyword performance insights
   */
  static generateKeywordInsights(keywordData) {
    const totalKeywords = keywordData.totalKeywords || 0;
    const topRankingsCount = keywordData.topRankings?.length || 0;
    const opportunitiesCount = keywordData.opportunities?.length || 0;
    const notRankingCount = keywordData.notRanking?.length || 0;

    // No keywords tracked
    if (totalKeywords === 0) {
      return "Let's talk about your keyword strategy. Currently, you're not tracking any specific keywords in our system, which means you're missing out on valuable insights into how people are finding you online. Setting up keyword tracking would give you a clear picture of your search visibility.";
    }

    // All keywords not ranking
    if (notRankingCount === totalKeywords) {
      return `Looking at your keyword performance, we found that none of your ${totalKeywords} tracked keywords are currently ranking in the top 100 search results. While this might seem discouraging, it actually represents a significant opportunity. Each of these keywords, when properly optimized, could become a new stream of organic traffic and potential customers for your business.`;
    }

    // Mixed performance
    if (topRankingsCount > 0 && opportunitiesCount > 0 && notRankingCount > 0) {
      return `Your keyword performance shows a mixed but promising picture. ${topRankingsCount} of your keywords are already ranking well, which proves you can compete in search results. Meanwhile, ${opportunitiesCount} keywords are positioned just outside the top 30, representing immediate growth opportunities. The ${notRankingCount} keywords not yet ranking need targeted optimization to start appearing in search results.`;
    }

    // Strong performance
    if (topRankingsCount > 0 && notRankingCount === 0) {
      return `Excellent progress with your keyword strategy! All ${totalKeywords} of your tracked keywords are ranking, with ${topRankingsCount} achieving top positions. This strong foundation shows you're doing many things right and can be leveraged to capture even more search visibility and traffic.`;
    }

    // Growth opportunity focus
    if (opportunitiesCount > 0) {
      return `The exciting news is you have ${opportunitiesCount} keywords positioned just outside the top 30. These represent your immediate growth opportunities. With focused optimization, these could move to page one and significantly increase your organic traffic without requiring massive changes to your website.`;
    }

    // Default
    return `You're tracking ${totalKeywords} keywords, and while some are performing well, others present opportunities for improvement. Let's explore how to optimize your keyword strategy for better search visibility.`;
  }
}

export default NarrationGeneratorService;
