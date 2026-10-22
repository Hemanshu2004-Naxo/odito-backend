# PDF Data API - Response Example

## Endpoint: `GET /api/pdf/:projectId`

### Sample Response Structure

```json
{
  "success": true,
  "data": {
    "cover": {
      "domain": "agencyplatform.com",
      "companyName": "Agency Platform Inc.",
      "auditDate": "March 20, 2026",
      "engine": "Odito AI Engine v2",
      "pagesCrawled": 312,
      "preparedFor": "Agency Platform Inc.",
      "overallScore": 58,
      "overallGrade": "C+",
      "scores": {
        "performance": 71,
        "authority": 43,
        "seoHealth": 67,
        "aiVisibility": 41
      },
      "issues": {
        "critical": 8,
        "warnings": 14,
        "informational": 22,
        "checksPassed": 47,
        "pagesCrawled": 312
      }
    },
    "executiveSummary": {
      "scores": {
        "seoHealth": {
          "value": 67,
          "grade": "C+",
          "color": "#F59E0B"
        },
        "aiVisibility": {
          "value": 41,
          "grade": "D",
          "color": "#EF4444"
        },
        "performance": {
          "value": 71,
          "grade": "B",
          "color": "#F59E0B"
        },
        "authority": {
          "value": 43,
          "grade": "D",
          "color": "#EF4444"
        }
      },
      "issues": {
        "critical": 8,
        "warnings": 14,
        "informational": 22,
        "checksPassed": 47
      },
      "issueDistribution": {
        "critical": { "count": 8, "percentage": 10.8 },
        "warnings": { "count": 14, "percentage": 18.9 },
        "info": { "count": 22, "percentage": 29.7 },
        "passed": { "count": 47, "percentage": 40.6 }
      },
      "aiAnalysis": "Overall site health is fair with a score of 58/100. AI visibility is significantly below average at 41/100 (poor). Key gaps include structured schema implementation and entity coverage...",
      "insights": [
        {
          "type": "opportunity",
          "title": "Significant AI Opportunity",
          "description": "59-point AI visibility gap represents major growth potential in AI search."
        }
      ]
    },
    "keyStrengths": {
      "strengths": [
        "Strong performance metrics",
        "Solid domain authority",
        "Good SEO foundation",
        "Valid SSL certificate",
        "XML sitemap accessible",
        "Mobile-responsive design"
      ],
      "issues": [
        "Missing JSON-LD schema",
        "Knowledge Graph not claimed",
        "Mobile LCP optimization needed",
        "AI visibility optimization",
        "Entity coverage enhancement",
        "Content structure improvements"
      ],
      "priorityAssessment": "8 critical issues require immediate attention. Focus on technical foundations before advanced optimizations."
    },
    "roadmap": {
      "actions": [
        {
          "id": 1,
          "issue": "Fix critical technical issues",
          "impact": "High",
          "effort": "Medium",
          "estimatedGain": "+24 pts",
          "timeline": "Day 1-3"
        },
        {
          "id": 2,
          "issue": "Implement AI visibility optimizations",
          "impact": "High",
          "effort": "Medium",
          "estimatedGain": "+17 pts",
          "timeline": "Day 4-7"
        }
      ],
      "impactForecast": "Implementing all 8 recommended actions is projected to improve overall score by 85 points within 30 days..."
    },
    "seoHealth": {
      "scoreBreakdown": [
        {
          "label": "SEO Health",
          "value": 67,
          "color": "#F59E0B"
        },
        {
          "label": "AI Visibility",
          "value": 41,
          "color": "#EF4444"
        },
        {
          "label": "Performance",
          "value": 71,
          "color": "#F59E0B"
        },
        {
          "label": "Authority",
          "value": 43,
          "color": "#EF4444"
        },
        {
          "label": "Overall Score",
          "value": 58,
          "color": "#F97316"
        }
      ],
      "gradeReference": [
        {
          "range": "90-100",
          "grade": "A+",
          "status": "Excellent",
          "color": "#10B981",
          "meaning": "Top percentile — elite signals across all categories"
        }
      ],
      "scoreInterpretation": "Moderate performance at 58/100. Systematic improvements needed across multiple areas for competitive advantage."
    },
    "onPageSEO": {
      "stats": {
        "critical": 8,
        "high": 6,
        "medium": 4,
        "low": 2
      },
      "issues": [
        {
          "id": 1,
          "issue": "Schema Markup Missing",
          "severity": "CRITICAL",
          "pages": 206,
          "impact": "High",
          "recommendedFix": "Add JSON-LD to all pages"
        }
      ],
      "priorityRecommendation": "High issue density (26.0% of pages affected). Prioritize technical fixes affecting multiple pages..."
    },
    "structuredData": {
      "stats": {
        "withSchema": 106,
        "missingSchema": 206,
        "coverage": 34,
        "errors": 47
      },
      "schemaTypes": [
        {
          "type": "Article",
          "count": 48
        },
        {
          "type": "WebPage",
          "count": 31
        }
      ],
      "whyItMatters": [
        {
          "platform": "Google Rich Results",
          "withSchema": "Enhanced listings, snippets, carousels",
          "withoutSchema": "Standard blue link only",
          "gap": "High visibility loss"
        }
      ],
      "impact": "Low schema coverage at 34%. Implementing comprehensive schema markup is critical for AI visibility."
    },
    "technicalSEO": {
      "stats": {
        "passed": 5,
        "warnings": 4,
        "failed": 4,
        "techHealth": 38
      },
      "checks": [
        {
          "check": "SSL Certificate",
          "status": "PASS",
          "finding": "Valid SSL certificate installed and properly configured"
        },
        {
          "check": "Robots.txt",
          "status": "FAIL",
          "finding": "Robots.txt not accessible or missing"
        }
      ],
      "priorityAnalysis": "4 critical technical issues require immediate attention. Focus on SSL, HTTPS, and robots.txt fixes..."
    },
    "crawlability": {
      "stats": {
        "pagesCrawled": 312,
        "pagesIndexed": 287,
        "pagesBlocked": 25,
        "indexRate": 92
      },
      "blockedPages": [
        {
          "reason": "Noindex meta tag",
          "affected": 8,
          "seoImpact": "High",
          "fix": "Remove noindex tags from important pages"
        }
      ],
      "insight": "Excellent index rate at 92%. 312 pages successfully indexed with minimal crawl budget waste."
    },
    "coreWebVitals": {
      "stats": {
        "desktopScore": 82,
        "mobileScore": 71,
        "mobileLCP": "3.2s",
        "mobileTBT": "280ms"
      },
      "metrics": [
        {
          "metric": "First Contentful Paint",
          "desktop": "1.4s",
          "desktopRating": "Good",
          "mobile": "2.1s",
          "mobileRating": "Needs Work",
          "priority": "MEDIUM"
        }
      ],
      "seoImpact": "Good Core Web Vitals with room for improvement. Mobile score (71) and desktop score (82) can be enhanced..."
    },
    "performance": {
      "opportunities": [
        {
          "optimization": "Eliminate render-blocking resources",
          "saving": "840ms",
          "effort": "Easy",
          "cumulativeImpact": "840ms",
          "priority": "HIGH"
        }
      ],
      "forecast": [
        {
          "label": "Current",
          "lcp": "3.2s",
          "score": 71,
          "status": "Needs Work"
        }
      ],
      "optimizationPlan": "Implement performance optimizations in priority order for maximum impact..."
    },
    "keywords": {
      "stats": {
        "top3Rankings": 2,
        "top10Rankings": 6,
        "positionsGained": 7,
        "nearTop10": 4
      },
      "rankings": [
        {
          "keyword": "SEO audit services",
          "volume": "1,200",
          "rank": "12",
          "previous": "18",
          "change": "+6",
          "difficulty": "45",
          "highlight": true
        }
      ],
      "growthForecast": "Current 6 keywords in top 10 with 4 near top-10 positions. Focused optimization could achieve 9 top-10 rankings..."
    },
    "keywordOpportunities": {
      "opportunities": [
        {
          "keyword": "SEO audit services",
          "volume": "1,200",
          "position": "12",
          "gap": "2",
          "estimatedClicks": 180
        }
      ],
      "distribution": {
        "Top 3": 2,
        "Pos 4-10": 4,
        "Pos 11-20": 3,
        "Pos 21-30": 1,
        "30+": 0
      },
      "growthForecast": "6 near top-10 opportunities represent 5,740 monthly searches with potential for 1,240 additional clicks..."
    },
    "aiVisibility": {
      "scores": {
        "aiReadiness": 41,
        "geoScore": 36,
        "aeoScore": 38,
        "aiseoScore": 41
      },
      "concepts": [
        {
          "tag": "GEO",
          "title": "Generative Engine Optimization",
          "description": "Optimising content so AI models like ChatGPT and Gemini cite your pages..."
        }
      ],
      "gapAnalysis": "AI Readiness 41/100 — significantly below industry average (~55). Missing schema and Knowledge Graph optimization..."
    },
    "llmVisibility": {
      "stats": {
        "citationRate": "12%",
        "industryAverage": 43,
        "gapToClose": 31,
        "platforms": 4
      },
      "platforms": [
        {
          "name": "ChatGPT",
          "pct": 18,
          "gap": "25% gap"
        }
      ],
      "signals": [
        {
          "signal": "Structured Data",
          "status": "34% coverage",
          "impact": "+15-20%",
          "fix": "Add JSON-LD to all pages"
        }
      ]
    },
    "contentReadiness": {
      "signals": [
        {
          "label": "Schema Coverage",
          "pct": 34,
          "color": "#F59E0B",
          "sub": "34% — 66% of pages missing JSON-LD"
        }
      ],
      "checklist": [
        {
          "signal": "Answer query in first 60 words",
          "status": "Failing (38/312)",
          "recommendation": "Rewrite intros to lead with direct answer"
        }
      ],
      "readinessScore": 42
    },
    "knowledgeGraph": {
      "status": "Not Claimed",
      "stats": {
        "entitiesLinked": 3,
        "entitiesMissing": 4,
        "partialCoverage": 1
      },
      "entities": [
        {
          "name": "Organization",
          "status": "Linked",
          "pages": 1,
          "action": "Optimize with more details"
        }
      ],
      "impact": "Limited entity coverage at 52%. Comprehensive entity strategy is critical for brand authority..."
    },
    "aiOptimization": {
      "actions": [
        {
          "id": 1,
          "action": "Add comprehensive JSON-LD schema",
          "impact": "+15 pts",
          "effort": "Easy",
          "priority": "P1"
        }
      ],
      "steps": [
        {
          "id": 1,
          "title": "Schema Implementation",
          "description": "Add Organization, Article, and FAQPage schemas to all relevant pages..."
        }
      ]
    },
    "growthForecast": {
      "projections": [
        {
          "label": "Current",
          "seo": 67,
          "ai": 41,
          "performance": 71
        },
        {
          "label": "30 Days",
          "seo": 74,
          "ai": 48,
          "performance": 76
        }
      ],
      "milestones": [
        {
          "milestone": "Current",
          "seo": 67,
          "ai": 41,
          "performance": 71,
          "overall": 58
        }
      ],
      "projection": "Projected 21-point overall improvement in 90 days, with AI Visibility leading gains at +14 points..."
    },
    "actionPlan": {
      "weeks": [
        {
          "week": 1,
          "title": "Technical Quick Wins",
          "days": "Days 1-7",
          "tasks": [
            "Fix SSL certificate issues",
            "Implement HTTPS redirects",
            "Optimize robots.txt file",
            "Submit XML sitemap to search engines"
          ]
        }
      ],
      "impactForecast": "Expected to resolve 42 issues and improve overall score by 17 points within 30 days..."
    },
    "methodology": {
      "steps": [
        {
          "id": 1,
          "title": "Crawler Engine",
          "description": "Advanced web crawler analyzes site structure, content, and technical implementation..."
        }
      ]
    },
    "about": {
      "features": [
        {
          "title": "SEO Audit Engine",
          "description": "Comprehensive technical SEO analysis with actionable recommendations..."
        }
      ]
    },
    "metadata": {
      "generatedAt": "2026-03-20T16:40:00.000Z",
      "projectId": "507f1f77bcf86cd799439011",
      "projectName": "Agency Platform",
      "domain": "agencyplatform.com",
      "dataFreshness": "recent",
      "version": "1.0.0"
    }
  },
  "metadata": {
    "generatedAt": "2026-03-20T16:40:00.000Z",
    "generationTime": 347,
    "projectId": "507f1f77bcf86cd799439011",
    "sections": 30,
    "dataFreshness": "recent"
  }
}
```

## Performance Metrics

- **Generation Time**: ~350ms
- **Memory Usage**: ~100KB
- **Database Queries**: 11 parallel aggregations
- **Data Points**: ~500+ metrics calculated
- **Sections Generated**: 30 complete sections

## Error Response Example

```json
{
  "success": false,
  "error": {
    "message": "Project ID is required",
    "code": "MISSING_PROJECT_ID"
  }
}
```

## Section-Specific Endpoint

### `GET /api/pdf/:projectId/section/:section`

Returns only the requested section data with the same structure as above.

Valid sections: `cover`, `executiveSummary`, `keyStrengths`, `roadmap`, `seoHealth`, `onPageSEO`, `structuredData`, `technicalSEO`, `crawlability`, `coreWebVitals`, `performance`, `keywords`, `keywordOpportunities`, `aiVisibility`, `llmVisibility`, `contentReadiness`, `knowledgeGraph`, `aiOptimization`, `growthForecast`, `actionPlan`, `methodology`, `about`

## Performance Optimization

- **Caching**: Planned Redis implementation with 1-hour TTL
- **Parallel Queries**: All database aggregations run simultaneously
- **Lazy Loading**: Heavy calculations only when needed
- **Memory Management**: Efficient data structures and cleanup
- **Error Handling**: Graceful degradation for missing data

## Data Sources

The API aggregates data from multiple MongoDB collections:

- `seoprojects` - Basic project information
- `seo_ai_visibility_project` - AI visibility summary
- `seo_ai_visibility` - AI visibility page data
- `seo_ai_visibility_issues` - AI visibility issues
- `ai_visibility_entities` - Entity data
- `domain_technical_reports` - Technical SEO data
- `seo_page_issues` - Page-level issues
- `seo_page_data` - Page metadata
- `seo_internal_links` - Internal link data
- `seo_external_links` - External link data
- `seo_social_links` - Social link data
