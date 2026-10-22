/**
 * Debug Audit Flow Service
 * Traces data loss in AI script generation pipeline
 */

import { UnifiedJsonService } from '../../pdf/service/unifiedJsonService.js';
import { AiDataService } from './aiData.service.js';

/**
 * 🔧 STEP 1: CREATE DEBUG FUNCTION
 * Complete debug flow to trace data loss
 * 
 * @param {string} projectId - Project ID to debug
 * @returns {Object} Debug results
 */
async function debugAuditFlow(projectId) {
  console.log("🚀 DEBUG START");
  console.log(`📋 Project ID: ${projectId}`);
  console.log("=".repeat(60));

  try {
    //------------------------------------------------
    // STEP 1: CALL UNIFIED SERVICE DIRECTLY
    //------------------------------------------------
    console.log("\n================ STEP 1: UNIFIED SERVICE ================");
    let unifiedData;
    try {
      unifiedData = await UnifiedJsonService.getFullReportJson(projectId, {
        includeMetadata: true
      });
      console.log("✅ UnifiedJsonService SUCCESS");
      console.log(`Success: ${unifiedData.success}`);
      console.log(`Has data: ${!!unifiedData.data}`);
    } catch (error) {
      console.error("❌ UnifiedJsonService FAILED:", error.message);
      unifiedData = { success: false, error: error.message, data: null };
    }

    //------------------------------------------------
    // STEP 2: CALL AI DATA SERVICE (WRAPPER)
    //------------------------------------------------
    console.log("\n================ STEP 2: AI DATA SERVICE ================");
    let aiDataResult;
    try {
      aiDataResult = await AiDataService.fetchAuditData(projectId);
      console.log("✅ AiDataService SUCCESS");
      console.log(`Success: ${aiDataResult.success}`);
      console.log(`Has data: ${!!aiDataResult.data}`);
    } catch (error) {
      console.error("❌ AiDataService FAILED:", error.message);
      aiDataResult = { success: false, error: error.message, data: null };
    }

    //------------------------------------------------
    // STEP 3: PRINT FULL RAW RESPONSES
    //------------------------------------------------
    console.log("\n================ RAW API RESPONSES ================");
    
    console.log("\n--- UNIFIED SERVICE RAW DATA ---");
    if (unifiedData.success && unifiedData.data) {
      console.log(JSON.stringify(unifiedData.data, null, 2));
    } else {
      console.log("❌ No unified data available");
    }

    console.log("\n--- AI DATA SERVICE RAW DATA ---");
    if (aiDataResult.success && aiDataResult.data) {
      console.log(JSON.stringify(aiDataResult.data, null, 2));
    } else {
      console.log("❌ No AI data available");
    }

    //------------------------------------------------
    // STEP 4: CHECK ALL POSSIBLE PATHS
    //------------------------------------------------
    console.log("\n================ PATH CHECK ================");
    
    // Use the data that's actually used by the script generation
    const data = aiDataResult.success ? aiDataResult.data : unifiedData.data;
    
    if (!data) {
      console.error("❌ NO DATA AVAILABLE TO DEBUG");
      return { success: false, error: "No data available" };
    }

    console.log("Using data source:", aiDataResult.success ? "AiDataService" : "UnifiedJsonService");
    
    // Check all possible paths for issueDistribution
    console.log("\n--- issueDistribution PATHS ---");
    console.log("data.issueDistribution:", data?.issueDistribution);
    console.log("data.data?.issueDistribution:", data?.data?.issueDistribution);
    console.log("data.executiveSummary?.issueDistribution:", data?.executiveSummary?.issueDistribution);
    console.log("data.issues?.issueDistribution:", data?.issues?.issueDistribution);

    // Check all possible paths for scores
    console.log("\n--- scores PATHS ---");
    console.log("data.scores:", data?.scores);
    console.log("data.data?.scores:", data?.data?.scores);
    console.log("data.executiveSummary?.scores:", data?.executiveSummary?.scores);

    // Check all possible paths for project info
    console.log("\n--- project PATHS ---");
    console.log("data.project:", data?.project);
    console.log("data.data?.project:", data?.data?.project);

    //------------------------------------------------
    // STEP 5: PICK CORRECT SOURCE
    //------------------------------------------------
    console.log("\n================ SOURCE SELECTION ================");
    
    let source = data;
    let sourcePath = "data";
    
    // Try to find the correct path for issueDistribution
    if (data?.issueDistribution) {
      source = data;
      sourcePath = "data";
      console.log("✅ Using data.issueDistribution");
    } else if (data?.data?.issueDistribution) {
      source = data.data;
      sourcePath = "data.data";
      console.log("✅ Using data.data.issueDistribution");
    } else if (data?.executiveSummary?.issueDistribution) {
      source = data.executiveSummary;
      sourcePath = "data.executiveSummary";
      console.log("✅ Using data.executiveSummary.issueDistribution");
    } else {
      console.warn("⚠️ No issueDistribution found, using data as fallback");
    }

    console.log(`\n✅ SELECTED SOURCE PATH: ${sourcePath}`);
    console.log("✅ SELECTED SOURCE DATA:", JSON.stringify(source, null, 2));

    //------------------------------------------------
    // STEP 6: EXTRACT VALUES STEP-BY-STEP
    //------------------------------------------------
    console.log("\n================ STEP 6: VALUE EXTRACTION ================");
    
    // Extract issueDistribution
    console.log("\n--- Extracting issueDistribution ---");
    const rawIssueDistribution = source?.issueDistribution;
    console.log("Raw issueDistribution:", rawIssueDistribution);
    
    const issueDistribution = {
      total: rawIssueDistribution?.total || 0,
      critical: rawIssueDistribution?.critical || 0,
      medium: rawIssueDistribution?.medium || rawIssueDistribution?.warnings || 0,
      info: rawIssueDistribution?.info || rawIssueDistribution?.informational || 0
    };
    
    console.log("📊 EXTRACTED issueDistribution:", issueDistribution);

    // Extract scores
    console.log("\n--- Extracting scores ---");
    const rawScores = source?.scores;
    console.log("Raw scores:", rawScores);
    
    const scores = {
      overall: Math.round(rawScores?.seoHealth || rawScores?.overall || 0),
      performance: Math.round(rawScores?.performance || 0),
      seo: Math.round(rawScores?.seoHealth || 0),
      aiHub: Math.round(rawScores?.overall || 0)
    };
    
    console.log("📊 EXTRACTED scores:", scores);

    // Extract project info
    console.log("\n--- Extracting project info ---");
    const rawProject = source?.project;
    console.log("Raw project:", rawProject);
    
    const projectName = rawProject?.name || rawProject?.project_name || "N/A";
    const url = rawProject?.url || rawProject?.main_url || "N/A";
    
    console.log("📊 EXTRACTED project info:", { projectName, url });

    //------------------------------------------------
    // STEP 7: BUILD SNAPSHOT STEP-BY-STEP
    //------------------------------------------------
    console.log("\n================ STEP 7: SNAPSHOT BUILDING ================");
    
    console.log("\n--- Building auditSnapshot ---");
    
    const auditSnapshot = {
      projectName: projectName,
      url: url,
      scores: scores,
      issueDistribution: issueDistribution,
      metadata: {
        debugMode: true,
        sourcePath: sourcePath,
        timestamp: new Date().toISOString()
      }
    };
    
    console.log("📦 FINAL SNAPSHOT:", JSON.stringify(auditSnapshot, null, 2));

    //------------------------------------------------
    // STEP 8: VALIDATION AND FAILURE POINT IDENTIFICATION
    //------------------------------------------------
    console.log("\n================ STEP 8: VALIDATION ================");
    
    const validationResults = {
      issueDistributionValid: issueDistribution.critical > 0 || issueDistribution.total > 0,
      scoresValid: scores.overall > 0 || scores.aiHub > 0,
      projectValid: projectName !== "N/A",
      dataLossDetected: false,
      failurePoint: null
    };

    if (issueDistribution.critical === 0 && issueDistribution.total === 0) {
      console.error("❌ ERROR: ISSUE DISTRIBUTION DATA LOST!");
      validationResults.dataLossDetected = true;
      validationResults.failurePoint = "issueDistribution mapping";
    }

    if (scores.overall === 0 && scores.aiHub === 0 && scores.performance === 0) {
      console.error("❌ ERROR: SCORES DATA LOST!");
      validationResults.dataLossDetected = true;
      validationResults.failurePoint = "scores mapping";
    }

    if (projectName === "N/A") {
      console.error("❌ ERROR: PROJECT DATA LOST!");
      validationResults.dataLossDetected = true;
      validationResults.failurePoint = "project mapping";
    }

    if (!validationResults.dataLossDetected) {
      console.log("✅ SUCCESS: All data mapping correct");
    }

    //------------------------------------------------
    // STEP 9: SUMMARY
    //------------------------------------------------
    console.log("\n================ DEBUG SUMMARY ================");
    
    const summary = {
      projectId,
      dataSources: {
        unifiedService: unifiedData.success,
        aiDataService: aiDataResult.success,
        selectedSource: sourcePath
      },
      dataIntegrity: {
        issueDistribution: {
          critical: issueDistribution.critical,
          total: issueDistribution.total,
          valid: validationResults.issueDistributionValid
        },
        scores: {
          overall: scores.overall,
          aiHub: scores.aiHub,
          valid: validationResults.scoresValid
        },
        project: {
          name: projectName,
          valid: validationResults.projectValid
        }
      },
      validation: validationResults,
      auditSnapshot: auditSnapshot
    };

    console.log("📋 SUMMARY:", JSON.stringify(summary, null, 2));

    console.log("\n🏁 DEBUG END");
    
    return {
      success: true,
      summary: summary
    };

  } catch (error) {
    console.error("❌ DEBUG FLOW FAILED:", error);
    console.error("Stack trace:", error.stack);
    
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
}

export { debugAuditFlow };
