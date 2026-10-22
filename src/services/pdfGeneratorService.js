/**
 * PDF Generator Service
 * 
 * Bridges the job completion handler to the Puppeteer PDF automation.
 * Maintains the same public API (generateRealPDF) that jobCompletionHandler
 * already calls, but delegates to puppeteerPdfService under the hood.
 * 
 * Includes retry logic and fallback for production resilience.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateProjectPDF } from './puppeteerPdfService.js';
import User from '../modules/user/model/User.js';
import mongoose from 'mongoose';
import { getServiceUrls } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Generate PDF for a completed project/job.
 * Called from jobCompletionHandler.sendReportEmailForFinalJob().
 * 
 * @param {string} projectId - Project ID
 * @param {string|Object} jobIdOrJob - Job ID or job document
 * @returns {Promise<string>} Public URL of the generated PDF
 */
export async function generateRealPDF(projectId, jobIdOrJob) {
  const jobId = typeof jobIdOrJob === 'object' ? jobIdOrJob._id?.toString() : jobIdOrJob?.toString();
  
  console.log(`🖨️  [PDF_GENERATOR] Starting PDF generation`);
  console.log(`🖨️  [PDF_GENERATOR]   projectId: ${projectId}`);
  console.log(`🖨️  [PDF_GENERATOR]   jobId    : ${jobId}`);

  // Resolve the project owner's user ID
  const userId = await resolveUserId(projectId, jobIdOrJob);

  if (!userId) {
    console.error(`🖨️  [PDF_GENERATOR] ❌ Could not resolve user ID for project: ${projectId}`);
    throw new Error(`Cannot generate PDF: no user found for project ${projectId}`);
  }

  console.log(`🖨️  [PDF_GENERATOR]   userId   : ${userId}`);

  // Retry logic: attempt up to 2 times
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`🖨️  [PDF_GENERATOR] Attempt ${attempt}/2 ...`);

      const result = await generateProjectPDF(projectId, userId);

      console.log(`🖨️  [PDF_GENERATOR] ✅ PDF generated successfully on attempt ${attempt}`);
      console.log(`🖨️  [PDF_GENERATOR]   url : ${result.publicUrl}`);
      console.log(`🖨️  [PDF_GENERATOR]   file: ${result.filePath}`);
      console.log(`🖨️  [PDF_GENERATOR]   size: ${(result.fileSize / 1024).toFixed(1)} KB`);
      console.log(`🖨️  [PDF_GENERATOR]   time: ${(result.generationTimeMs / 1000).toFixed(1)}s`);

      return result.publicUrl;

    } catch (error) {
      lastError = error;
      console.error(`🖨️  [PDF_GENERATOR] ❌ Attempt ${attempt} failed: ${error.message}`);

      if (attempt < 2) {
        console.log(`🖨️  [PDF_GENERATOR] 🔄 Retrying in 5 seconds...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  // All attempts failed — return a fallback URL
  console.error(`🖨️  [PDF_GENERATOR] ❌ All PDF generation attempts failed for project: ${projectId}`);
  console.error(`🖨️  [PDF_GENERATOR] Last error: ${lastError?.message}`);

  // Return a fallback URL so the email still sends (with a link to generate manually)
  const serviceUrls = getServiceUrls();
  const fallbackUrl = `${serviceUrls.backend}/api/export/projects/${projectId}/export/seo`;
  console.log(`🖨️  [PDF_GENERATOR] ⚠️  Using fallback URL: ${fallbackUrl}`);

  return fallbackUrl;
}

/**
 * Resolve the user ID who owns this project.
 * Checks the job document first, then queries the DB.
 * 
 * @param {string} projectId - Project ID
 * @param {string|Object} jobIdOrJob - Job ID or job document
 * @returns {Promise<string|null>} User ID string
 */
async function resolveUserId(projectId, jobIdOrJob) {
  // 1. If job document was passed directly, extract user_id
  if (typeof jobIdOrJob === 'object' && jobIdOrJob?.user_id) {
    return jobIdOrJob.user_id.toString();
  }

  // 2. Try to find the job and get user_id from it
  if (jobIdOrJob && typeof jobIdOrJob === 'string') {
    try {
      const Job = mongoose.model('Job');
      const job = await Job.findById(jobIdOrJob).lean();
      if (job?.user_id) {
        return job.user_id.toString();
      }
    } catch (err) {
      console.warn(`🖨️  [PDF_GENERATOR] Could not resolve job: ${err.message}`);
    }
  }

  // 3. Fall back to looking up the project directly
  try {
    const db = mongoose.connection.db;
    const project = await db.collection('seoprojects').findOne({
      _id: new mongoose.Types.ObjectId(projectId)
    });
    if (project?.user_id) {
      return project.user_id.toString();
    }
  } catch (err) {
    console.warn(`🖨️  [PDF_GENERATOR] Could not resolve project owner: ${err.message}`);
  }

  return null;
}

/**
 * Test PDF generation (for manual debugging)
 * @param {string} projectId - Test project ID
 * @param {string} userId - Test user ID
 */
export async function testPDFGeneration(projectId, userId) {
  console.log(`🧪 Testing Puppeteer PDF generation`);
  console.log(`   projectId: ${projectId}`);
  console.log(`   userId   : ${userId}`);

  try {
    const result = await generateProjectPDF(projectId, userId);
    console.log(`✅ Test successful!`);
    console.log(`   File: ${result.filePath}`);
    console.log(`   URL : ${result.publicUrl}`);
    console.log(`   Size: ${(result.fileSize / 1024).toFixed(1)} KB`);
    return result;
  } catch (error) {
    console.error(`❌ Test failed: ${error.message}`);
    throw error;
  }
}

export default {
  generateRealPDF,
  testPDFGeneration
};
