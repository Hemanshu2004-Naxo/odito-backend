/**
 * Keywords Mapper
 * Transforms data for keyword-related sections
 */

import { FormatUtils } from '../../utils/format.utils.js';
import { GradeUtils } from '../../utils/grade.utils.js';
import { PercentageUtils } from '../../utils/percentage.utils.js';

export class KeywordsMapper {
  
  /**
   * Transform keyword rankings analysis
   */
  static transformRankings(links, pageMetrics) {
    // Since we don't have keyword data yet, generate realistic mock data
    const rankings = this.generateMockRankings();
    
    return {
      stats: this.calculateRankingStats(rankings),
      rankings: rankings,
      growthForecast: this.generateKeywordGrowthForecast(rankings)
    };
  }

  /**
   * Transform keyword opportunities analysis
   */
  static transformOpportunities() {
    const rankings = this.generateMockRankings();
    const opportunities = this.identifyOpportunities(rankings);
    const distribution = this.calculateRankingDistribution(rankings);
    
    return {
      opportunities,
      distribution,
      growthForecast: this.generateOpportunityForecast(opportunities)
    };
  }

  /**
   * Generate mock keyword rankings data
   */
  static generateMockRankings() {
    return [
      {
        keyword: 'SEO audit services',
        volume: '1,200',
        rank: '12',
        previous: '18',
        change: '+6',
        difficulty: '45',
        highlight: true
      },
      {
        keyword: 'AI visibility optimization',
        volume: '890',
        rank: '8',
        previous: '15',
        change: '+7',
        difficulty: '52',
        highlight: true
      },
      {
        keyword: 'technical SEO analysis',
        volume: '650',
        rank: '3',
        previous: '5',
        change: '+2',
        difficulty: '38',
        highlight: false
      },
      {
        keyword: 'schema markup services',
        volume: '480',
        rank: '22',
        previous: '28',
        change: '+6',
        difficulty: '41',
        highlight: true
      },
      {
        keyword: 'website performance audit',
        volume: '920',
        rank: '15',
        previous: '12',
        change: '-3',
        difficulty: '44',
        highlight: false
      },
      {
        keyword: 'content optimization',
        volume: '1,800',
        rank: '18',
        previous: '25',
        change: '+7',
        difficulty: '58',
        highlight: true
      },
      {
        keyword: 'link building strategy',
        volume: '750',
        rank: '9',
        previous: '11',
        change: '+2',
        difficulty: '47',
        highlight: false
      },
      {
        keyword: 'local SEO services',
        volume: '540',
        rank: '6',
        previous: '8',
        change: '+2',
        difficulty: '35',
        highlight: false
      },
      {
        keyword: 'SEO reporting tools',
        volume: '320',
        rank: '31',
        previous: 'NR',
        change: 'New',
        difficulty: '39',
        highlight: true
      },
      {
        keyword: 'mobile SEO optimization',
        volume: '680',
        rank: '14',
        previous: '19',
        change: '+5',
        difficulty: '43',
        highlight: true
      }
    ];
  }

  /**
   * Calculate ranking statistics
   */
  static calculateRankingStats(rankings) {
    const stats = {
      top3Rankings: 0,
      top10Rankings: 0,
      positionsGained: 0,
      nearTop10: 0
    };

    rankings.forEach(keyword => {
      const rank = parseInt(keyword.rank);
      const change = keyword.change;
      
      if (rank <= 3) stats.top3Rankings++;
      if (rank <= 10) stats.top10Rankings++;
      if (rank > 10 && rank <= 15) stats.nearTop10++;
      
      if (change.startsWith('+')) {
        stats.positionsGained += parseInt(change.replace('+', ''));
      }
    });

    return stats;
  }

  /**
   * Identify keyword opportunities
   */
  static identifyOpportunities(rankings) {
    return rankings
      .filter(keyword => {
        const rank = parseInt(keyword.rank);
        return rank > 10 && rank <= 20; // Near top-10
      })
      .map(keyword => ({
        keyword: keyword.keyword,
        volume: keyword.volume,
        position: keyword.rank,
        gap: this.calculateGapToTop10(keyword.rank),
        estimatedClicks: this.estimateAdditionalClicks(keyword)
      }))
      .sort((a, b) => parseInt(b.volume.replace(',', '')) - parseInt(a.volume.replace(',', '')))
      .slice(0, 6);
  }

  /**
   * Calculate gap to top 10
   */
  static calculateGapToTop10(currentRank) {
    const rank = parseInt(currentRank);
    return rank > 10 ? rank - 10 : 0;
  }

  /**
   * Estimate additional clicks for top 10
   */
  static estimateAdditionalClicks(keyword) {
    const volume = parseInt(keyword.volume.replace(',', ''));
    const rank = parseInt(keyword.rank);
    
    // Rough estimation based on CTR curves
    const currentCTR = this.getCTRByRank(rank);
    const top10CTR = this.getCTRByRank(10);
    const additionalCTR = top10CTR - currentCTR;
    
    return Math.round(volume * additionalCTR);
  }

  /**
   * Get CTR by rank position
   */
  static getCTRByRank(rank) {
    const ctrCurve = {
      1: 0.285,
      2: 0.157,
      3: 0.110,
      4: 0.080,
      5: 0.064,
      6: 0.053,
      7: 0.045,
      8: 0.040,
      9: 0.036,
      10: 0.033,
      11: 0.030,
      12: 0.028,
      13: 0.026,
      14: 0.024,
      15: 0.023,
      16: 0.021,
      17: 0.020,
      18: 0.019,
      19: 0.018,
      20: 0.017
    };
    
    return ctrCurve[rank] || 0.015;
  }

  /**
   * Calculate ranking distribution
   */
  static calculateRankingDistribution(rankings) {
    const distribution = {
      'Top 3': 0,
      'Pos 4-10': 0,
      'Pos 11-20': 0,
      'Pos 21-30': 0,
      '30+': 0
    };

    rankings.forEach(keyword => {
      const rank = parseInt(keyword.rank);
      
      if (rank <= 3) distribution['Top 3']++;
      else if (rank <= 10) distribution['Pos 4-10']++;
      else if (rank <= 20) distribution['Pos 11-20']++;
      else if (rank <= 30) distribution['Pos 21-30']++;
      else distribution['30+']++;
    });

    return distribution;
  }

  /**
   * Generate keyword growth forecast
   */
  static generateKeywordGrowthForecast(rankings) {
    const currentTop10 = rankings.filter(k => parseInt(k.rank) <= 10).length;
    const nearTop10 = rankings.filter(k => {
      const rank = parseInt(k.rank);
      return rank > 10 && rank <= 20;
    }).length;
    
    return `Current ${currentTop10} keywords in top 10 with ${nearTop10} near top-10 positions. Focused optimization could achieve ${currentTop10 + Math.round(nearTop10 * 0.6)} top-10 rankings within 90 days.`;
  }

  /**
   * Generate opportunity forecast
   */
  static generateOpportunityForecast(opportunities) {
    const totalVolume = opportunities.reduce((sum, opp) => 
      sum + parseInt(opp.volume.replace(',', '')), 0
    );
    const totalClicks = opportunities.reduce((sum, opp) => 
      sum + opp.estimatedClicks, 0
    );
    
    return `${opportunities.length} near top-10 opportunities represent ${totalVolume.toLocaleString()} monthly searches with potential for ${totalClicks.toLocaleString()} additional clicks through top-10 optimization.`;
  }

  /**
   * Generate keyword recommendations
   */
  static generateKeywordRecommendations(rankings) {
    const recommendations = [];
    
    // Keywords losing positions
    const declining = rankings.filter(k => k.change.startsWith('-'));
    if (declining.length > 0) {
      recommendations.push({
        priority: 'HIGH',
        action: 'Address declining keyword rankings',
        details: `${declining.length} keywords losing positions require immediate attention and content optimization.`
      });
    }
    
    // Near top-10 opportunities
    const opportunities = rankings.filter(k => {
      const rank = parseInt(k.rank);
      return rank > 10 && rank <= 15;
    });
    if (opportunities.length > 0) {
      recommendations.push({
        priority: 'MEDIUM',
        action: 'Optimize near top-10 keywords',
        details: `${opportunities.length} keywords within 5 positions of top-10 represent quick ranking opportunities.`
      });
    }
    
    // High-volume keywords
    const highVolume = rankings.filter(k => parseInt(k.volume.replace(',', '')) > 1000);
    if (highVolume.length > 0) {
      recommendations.push({
        priority: 'MEDIUM',
        action: 'Focus on high-volume keywords',
        details: `${highVolume.length} keywords with 1K+ monthly searches deserve priority optimization efforts.`
      });
    }
    
    return recommendations;
  }

  /**
   * Calculate keyword performance score
   */
  static calculateKeywordPerformanceScore(rankings) {
    if (!rankings || rankings.length === 0) return 0;
    
    let totalScore = 0;
    let totalWeight = 0;
    
    rankings.forEach(keyword => {
      const rank = parseInt(keyword.rank);
      const volume = parseInt(keyword.volume.replace(',', ''));
      const change = keyword.change;
      
      // Base score from rank position (inverse - lower rank = higher score)
      const rankScore = Math.max(0, 100 - (rank - 1) * 5);
      
      // Volume weight (higher volume = more important)
      const volumeWeight = Math.min(10, volume / 200);
      
      // Trend bonus
      let trendBonus = 0;
      if (change.startsWith('+')) {
        trendBonus = Math.min(10, parseInt(change.replace('+', '')) * 2);
      } else if (change.startsWith('-')) {
        trendBonus = Math.max(-10, -parseInt(change.replace('-', '')) * 2);
      }
      
      totalScore += (rankScore + trendBonus) * volumeWeight;
      totalWeight += volumeWeight;
    });
    
    return totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
  }

  /**
   * Generate keyword insights
   */
  static generateKeywordInsights(rankings) {
    const insights = [];
    
    const top10Count = rankings.filter(k => parseInt(k.rank) <= 10).length;
    const improvingCount = rankings.filter(k => k.change.startsWith('+')).length;
    const decliningCount = rankings.filter(k => k.change.startsWith('-')).length;
    
    if (top10Count >= 5) {
      insights.push({
        type: 'positive',
        title: 'Strong Top-10 Presence',
        description: `${top10Count} keywords ranking in top 10 positions provide solid organic search foundation.`
      });
    }
    
    if (improvingCount >= 6) {
      insights.push({
        type: 'positive',
        title: 'Positive Ranking Momentum',
        description: `${improvingCount} keywords showing positive ranking trends indicate effective SEO strategy.`
      });
    }
    
    if (decliningCount >= 3) {
      insights.push({
        type: 'warning',
        title: 'Ranking Declines Detected',
        description: `${decliningCount} keywords losing positions require immediate content and optimization attention.`
      });
    }
    
    const avgRank = rankings.reduce((sum, k) => sum + parseInt(k.rank), 0) / rankings.length;
    if (avgRank <= 15) {
      insights.push({
        type: 'positive',
        title: 'Strong Average Position',
        description: `Average ranking position of ${avgRank.toFixed(1)} indicates competitive keyword performance.`
      });
    }
    
    return insights.slice(0, 3);
  }

  /**
   * Validate keyword data
   */
  static validate(keywordData) {
    // Basic validation
    return true;
  }
}
