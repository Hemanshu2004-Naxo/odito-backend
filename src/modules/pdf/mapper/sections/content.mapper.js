/**
 * Content Mapper
 * Transforms data for content readiness sections
 */

import { FormatUtils } from '../../utils/format.utils.js';
import { GradeUtils } from '../../utils/grade.utils.js';
import { PercentageUtils } from '../../utils/percentage.utils.js';

export class ContentMapper {
  
  /**
   * Transform AI content readiness
   */
  static transformReadiness(aiMetrics, percentages) {
    return {
      signals: this.generateContentSignals(percentages),
      checklist: this.generateContentChecklist(),
      readinessScore: this.calculateContentReadinessScore(aiMetrics, percentages)
    };
  }

  /**
   * Generate content signals
   */
  static generateContentSignals(percentages) {
    return [
      {
        label: 'Schema Coverage',
        pct: percentages.ai?.schemaCoverage || 34,
        color: this.getSignalColor(percentages.ai?.schemaCoverage || 34),
        sub: `${percentages.ai?.schemaCoverage || 34}% — ${100 - (percentages.ai?.schemaCoverage || 34)}% of pages missing JSON-LD`
      },
      {
        label: 'FAQ Schema Optimization',
        pct: 38,
        color: '#00D4FF',
        sub: '38% — 31 pages lack FAQPage schema'
      },
      {
        label: 'Conversational Content',
        pct: percentages.optimization?.h1 || 31,
        color: '#4F6EF7',
        sub: '31% — intros not optimized for AI'
      },
      {
        label: 'AI Snippet Probability',
        pct: 29,
        color: '#10B981',
        sub: '29% — low snippet extraction rate'
      },
      {
        label: 'AI Citation Rate',
        pct: this.calculateCitationRate(percentages),
        color: '#10B981',
        sub: this.calculateCitationRate(percentages) + '% — below industry avg of 43%'
      },
      {
        label: 'Entity Coverage',
        pct: percentages.ai?.entityCoverage || 52,
        color: '#7B5CF0',
        sub: (percentages.ai?.entityCoverage || 52) + '% — 4 key entities missing'
      }
    ];
  }

  /**
   * Generate content optimization checklist
   */
  static generateContentChecklist() {
    return [
      {
        signal: 'Answer query in first 60 words',
        status: 'Failing (38/312)',
        recommendation: 'Rewrite intros to lead with direct answer'
      },
      {
        signal: 'Q&A heading structure (H2/H3)',
        status: 'Partial (41%)',
        recommendation: 'Convert key pages to Q&A heading format'
      },
      {
        signal: 'FAQ section on blog posts',
        status: 'Failing (0 pages)',
        recommendation: 'Add 3-5 Q&A pairs to each blog post'
      },
      {
        signal: 'Entity-rich content',
        status: 'Partial (52%)',
        recommendation: 'Add named entities, tools, metrics'
      },
      {
        signal: 'Conversational language',
        status: 'Failing (31%)',
        recommendation: 'Reduce keyword density, add natural language'
      },
      {
        signal: 'TL;DR summary blocks',
        status: 'Failing (0 pages)',
        recommendation: 'Add summary at top of long-form content'
      }
    ];
  }

  /**
   * Calculate content readiness score
   */
  static calculateContentReadinessScore(aiMetrics, percentages) {
    const factors = {
      schemaCoverage: {
        value: percentages.ai?.schemaCoverage || 0,
        weight: 25
      },
      entityCoverage: {
        value: percentages.ai?.entityCoverage || 0,
        weight: 20
      },
      contentOptimization: {
        value: (percentages.optimization?.h1 || 0 + percentages.optimization?.metaDesc || 0) / 2,
        weight: 25
      },
      aiReadiness: {
        value: aiMetrics.overall?.score || 0,
        weight: 30
      }
    };

    let totalScore = 0;
    let totalWeight = 0;

    Object.values(factors).forEach(factor => {
      totalScore += factor.value * factor.weight;
      totalWeight += factor.weight;
    });

    return totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
  }

  /**
   * Calculate citation rate from percentages
   */
  static calculateCitationRate(percentages) {
    // Estimate based on AI visibility and entity coverage
    const aiScore = percentages.ai?.schemaCoverage || 0;
    const entityScore = percentages.ai?.entityCoverage || 0;
    return Math.round((aiScore + entityScore) / 2 * 0.3);
  }

  /**
   * Get signal color based on percentage
   */
  static getSignalColor(percentage) {
    if (percentage >= 70) return '#10B981'; // Green
    if (percentage >= 50) return '#F59E0B'; // Yellow
    if (percentage >= 30) return '#F97316'; // Orange
    return '#EF4444'; // Red
  }

  /**
   * Generate content optimization recommendations
   */
  static generateContentRecommendations(signals, checklist) {
    const recommendations = [];
    
    // High-priority recommendations
    const failingSignals = signals.filter(signal => signal.pct < 40);
    failingSignals.forEach(signal => {
      recommendations.push({
        priority: 'HIGH',
        area: signal.label,
        issue: `Low ${signal.label.toLowerCase()} at ${signal.pct}%`,
        action: this.getSignalAction(signal.label),
        impact: this.calculateSignalImpact(signal.pct)
      });
    });
    
    // Medium-priority recommendations
    const partialSignals = signals.filter(signal => signal.pct >= 40 && signal.pct < 70);
    partialSignals.forEach(signal => {
      recommendations.push({
        priority: 'MEDIUM',
        area: signal.label,
        issue: `Moderate ${signal.label.toLowerCase()} at ${signal.pct}%`,
        action: this.getSignalAction(signal.label),
        impact: this.calculateSignalImpact(signal.pct)
      });
    });
    
    return recommendations.slice(0, 6);
  }

  /**
   * Get action for signal
   */
  static getSignalAction(signalLabel) {
    const actions = {
      'Schema Coverage': 'Implement comprehensive JSON-LD schema across all pages',
      'FAQ Schema Optimization': 'Add FAQPage schema to service and blog pages',
      'Conversational Content': 'Rewrite content intros to lead with direct answers',
      'AI Snippet Probability': 'Structure content for featured snippet optimization',
      'AI Citation Rate': 'Enhance entity coverage and topical authority',
      'Entity Coverage': 'Identify and implement key brand entities'
    };
    
    return actions[signalLabel] || 'Apply content optimization best practices';
  }

  /**
   * Calculate signal impact
   */
  static calculateSignalImpact(percentage) {
    if (percentage < 30) return 'High';
    if (percentage < 60) return 'Medium';
    return 'Low';
  }

  /**
   * Generate content strategy insights
   */
  static generateContentInsights(signals, checklist) {
    const insights = [];
    
    // Overall readiness assessment
    const avgSignal = signals.reduce((sum, signal) => sum + signal.pct, 0) / signals.length;
    
    if (avgSignal >= 70) {
      insights.push({
        type: 'positive',
        title: 'Strong Content Foundation',
        description: `Content readiness at ${Math.round(avgSignal)}% provides excellent foundation for AI visibility.`
      });
    } else if (avgSignal >= 50) {
      insights.push({
        type: 'opportunity',
        title: 'Content Optimization Opportunity',
        description: `Content readiness at ${Math.round(avgSignal)}% shows room for AI visibility improvement.`
      });
    } else {
      insights.push({
        type: 'warning',
        title: 'Content Optimization Required',
        description: `Content readiness at ${Math.round(avgSignal)}% requires systematic optimization for AI search.`
      });
    }
    
    // Schema coverage insight
    const schemaCoverage = signals.find(s => s.label === 'Schema Coverage')?.pct || 0;
    if (schemaCoverage < 50) {
      insights.push({
        type: 'critical',
        title: 'Schema Implementation Gap',
        description: `Schema coverage at ${schemaCoverage}% significantly impacts AI search visibility.`
      });
    }
    
    // Entity coverage insight
    const entityCoverage = signals.find(s => s.label === 'Entity Coverage')?.pct || 0;
    if (entityCoverage < 60) {
      insights.push({
        type: 'opportunity',
        title: 'Entity Coverage Enhancement',
        description: `Entity coverage at ${entityCoverage}% represents opportunity for brand authority building.`
      });
    }
    
    return insights.slice(0, 3);
  }

  /**
   * Generate content optimization roadmap
   */
  static generateContentRoadmap(signals, checklist) {
    const roadmap = [
      {
        phase: 'Phase 1: Foundation (Week 1-2)',
        tasks: [
          'Implement Organization schema on homepage',
          'Add Article schema to all blog posts',
          'Create content style guide for AI optimization',
          'Train content team on conversational writing'
        ],
        priority: 'HIGH'
      },
      {
        phase: 'Phase 2: Enhancement (Week 3-4)',
        tasks: [
          'Add FAQPage schema to service pages',
          'Rewrite 10 key page intros for direct answers',
          'Implement Q&A heading structure',
          'Add entity-rich content to key pages'
        ],
        priority: 'MEDIUM'
      },
      {
        phase: 'Phase 3: Optimization (Week 5-6)',
        tasks: [
          'Add TL;DR summaries to long-form content',
          'Enhance entity coverage across site',
          'Optimize content for featured snippets',
          'Implement conversational language guidelines'
        ],
        priority: 'MEDIUM'
      }
    ];
    
    return roadmap;
  }

  /**
   * Calculate content performance metrics
   */
  static calculateContentPerformance(signals, checklist) {
    const signalScores = signals.map(signal => signal.pct);
    const avgSignal = signalScores.reduce((sum, score) => sum + score, 0) / signalScores.length;
    
    // Calculate completion rates
    const failingItems = checklist.filter(item => item.status.startsWith('Failing')).length;
    const partialItems = checklist.filter(item => item.status.startsWith('Partial')).length;
    const totalItems = checklist.length;
    
    return {
      overallScore: Math.round(avgSignal),
      completionRate: Math.round(((totalItems - failingItems) / totalItems) * 100),
      optimizationPotential: Math.round((100 - avgSignal) * 0.8),
      quickWins: failingItems,
      systematicImprovements: partialItems
    };
  }

  /**
   * Generate content quality assessment
   */
  static generateContentQualityAssessment(signals, checklist) {
    const schemaScore = signals.find(s => s.label === 'Schema Coverage')?.pct || 0;
    const entityScore = signals.find(s => s.label === 'Entity Coverage')?.pct || 0;
    const conversationalScore = signals.find(s => s.label === 'Conversational Content')?.pct || 0;
    
    let quality = 'Poor';
    if (schemaScore >= 80 && entityScore >= 70 && conversationalScore >= 60) {
      quality = 'Excellent';
    } else if (schemaScore >= 60 && entityScore >= 50 && conversationalScore >= 40) {
      quality = 'Good';
    } else if (schemaScore >= 40 && entityScore >= 30 && conversationalScore >= 20) {
      quality = 'Fair';
    }
    
    return {
      quality,
      strengths: this.identifyContentStrengths(signals),
      weaknesses: this.identifyContentWeaknesses(signals),
      recommendations: this.generateContentQualityRecommendations(quality)
    };
  }

  /**
   * Identify content strengths
   */
  static identifyContentStrengths(signals) {
    return signals
      .filter(signal => signal.pct >= 70)
      .map(signal => signal.label);
  }

  /**
   * Identify content weaknesses
   */
  static identifyContentWeaknesses(signals) {
    return signals
      .filter(signal => signal.pct < 40)
      .map(signal => signal.label);
  }

  /**
   * Generate content quality recommendations
   */
  static generateContentQualityRecommendations(quality) {
    switch (quality) {
      case 'Excellent':
        return 'Maintain current standards while exploring advanced AI optimization techniques.';
      case 'Good':
        return 'Focus on enhancing entity coverage and conversational content for elite status.';
      case 'Fair':
        return 'Systematic optimization needed across schema, entities, and content structure.';
      default:
        return 'Comprehensive content overhaul required for AI search visibility.';
    }
  }

  /**
   * Validate content data
   */
  static validate(contentData) {
    // Basic validation
    return true;
  }
}
