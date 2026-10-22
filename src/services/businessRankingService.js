/**
 * Business Ranking Service
 * 
 * Ranks Google Places API results by relevance to user's search query
 * Uses weighted scoring algorithm for optimal business matching
 * 
 * Ranking Formula:
 * score = (nameSimilarity * 0.5) + (locationMatch * 0.3) + (ratingNormalized * 0.2)
 */

/**
 * Calculate string similarity using Levenshtein distance
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} - Similarity score between 0 and 1
 */
function calculateStringSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  if (s1 === s2) return 1;
  
  // Simple similarity based on character overlap
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  
  if (longer.length === 0) return 1;
  
  // Count matching characters
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) {
      matches++;
    }
  }
  
  return matches / longer.length;
}

/**
 * Calculate location match score
 * @param {string} searchLocation - Location from search query
 * @param {string} resultAddress - Address from Google Places result
 * @returns {number} - Location match score between 0 and 1
 */
function calculateLocationMatch(searchLocation, resultAddress) {
  if (!searchLocation || !resultAddress) return 0;
  
  const searchLoc = searchLocation.toLowerCase().trim();
  const resultAddr = resultAddress.toLowerCase().trim();
  
  // Check if search location is contained in result address
  if (resultAddr.includes(searchLoc)) {
    return 1;
  }
  
  // Check for partial matches
  const searchWords = searchLoc.split(' ');
  let matchCount = 0;
  
  for (const word of searchWords) {
    if (resultAddr.includes(word)) {
      matchCount++;
    }
  }
  
  return matchCount / searchWords.length;
}

/**
 * Normalize rating to 0-1 scale
 * @param {number} rating - Rating from Google Places (0-5)
 * @returns {number} - Normalized rating (0-1)
 */
function normalizeRating(rating) {
  if (!rating || rating < 0) return 0;
  if (rating > 5) return 1;
  return rating / 5;
}

/**
 * Calculate overall ranking score for a business result
 * @param {Object} business - Business result from Google Places
 * @param {string} searchName - Business name from search query
 * @param {string} searchLocation - Location from search query
 * @returns {Object} - Business with ranking score
 */
function calculateRankingScore(business, searchName, searchLocation) {
  // Name similarity (50% weight)
  const nameSimilarity = calculateStringSimilarity(searchName, business.name);
  
  // Location match (30% weight)
  const locationMatch = calculateLocationMatch(searchLocation, business.address);
  
  // Rating normalized (20% weight)
  const ratingNormalized = normalizeRating(business.rating);
  
  // Calculate weighted score
  const score = (nameSimilarity * 0.5) + (locationMatch * 0.3) + (ratingNormalized * 0.2);
  
  return {
    ...business,
    rankingScore: score
  };
}

/**
 * Rank business results by relevance
 * @param {Array} businesses - Array of business results from Google Places
 * @param {string} searchName - Business name from search query
 * @param {string} searchLocation - Location from search query
 * @param {number} maxResults - Maximum number of results to return (default: 5)
 * @returns {Array} - Ranked and filtered business results
 */
export function rankBusinessResults(businesses, searchName, searchLocation, maxResults = 5) {
  try {
    if (!Array.isArray(businesses) || businesses.length === 0) {
      return [];
    }
    
    if (!searchName || !searchLocation) {
      return businesses.slice(0, maxResults);
    }
    
    // Calculate ranking scores for all businesses
    const businessesWithScores = businesses.map(business => 
      calculateRankingScore(business, searchName, searchLocation)
    );
    
    // Sort by ranking score (descending)
    businessesWithScores.sort((a, b) => b.rankingScore - a.rankingScore);
    
    // Filter out results with very low scores (below 0.1)
    const filteredResults = businessesWithScores.filter(business => 
      business.rankingScore >= 0.1
    );
    
    // Return top results
    const topResults = filteredResults.slice(0, maxResults);
    
    return topResults;
    
  } catch (error) {
    console.error('[BUSINESS_RANKING] Ranking failed', {
      error: error.message,
      businessesCount: businesses?.length || 0
    });
    
    // Fallback: return unsorted results limited by maxResults
    return businesses.slice(0, maxResults);
  }
}

/**
 * Get the best matching business from results
 * @param {Array} businesses - Array of ranked business results
 * @returns {Object|null} - Best matching business or null
 */
export function getBestMatch(businesses) {
  if (!Array.isArray(businesses) || businesses.length === 0) {
    return null;
  }
  
  // Return the business with the highest ranking score
  return businesses.reduce((best, current) => 
    current.rankingScore > best.rankingScore ? current : best
  );
}

/**
 * Check if business results are good enough for user selection
 * @param {Array} businesses - Array of ranked business results
 * @param {number} minScore - Minimum acceptable score (default: 0.3)
 * @returns {boolean} - True if results are good enough
 */
export function hasGoodResults(businesses, minScore = 0.3) {
  if (!Array.isArray(businesses) || businesses.length === 0) {
    return false;
  }
  
  // Check if at least one result meets the minimum score
  return businesses.some(business => business.rankingScore >= minScore);
}

export default {
  rankBusinessResults,
  getBestMatch,
  hasGoodResults
};
