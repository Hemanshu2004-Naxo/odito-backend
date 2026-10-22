/**
 * Gemini AI Service
 * Handles integration with Google Gemini API for AI script generation
 */

import fetch from 'node-fetch';

// ✅ Configuration: Model fallback chain with per-model API versions
// Each model specifies its own API version (some models only work on specific versions)
const MODELS = [
  { model: 'gemini-2.0-flash',      version: 'v1beta' },
  { model: 'gemini-1.5-flash-001',  version: 'v1beta' },  // versioned alias
  { model: 'gemini-1.5-flash-8b',   version: 'v1beta' },  // lighter variant
  { model: 'gemini-1.0-pro',        version: 'v1beta' },  // oldest, most available on free tier
];
const DEFAULT_MODEL_INDEX = 0;
const GEMINI_MODEL = process.env.GEMINI_MODEL || MODELS[DEFAULT_MODEL_INDEX].model;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/${MODELS[DEFAULT_MODEL_INDEX].version}/models/${GEMINI_MODEL}:generateContent`;

export class GeminiService {
  /**
   * Get Gemini API URL for a specific model with its version
   * @param {string} model - Model name
   * @returns {string} API URL
   */
  static getApiUrl(model) {
    // Find the model config in MODELS array
    const modelConfig = MODELS.find(m => m.model === model);
    const version = modelConfig?.version || 'v1beta'; // fallback to v1beta if not found
    return `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent`;
  }
  
  /**
   * Generate video script using Gemini API with automatic model fallback
   * @param {string} prompt - AI prompt for script generation
   * @param {string} modelToUse - Optional model override
   * @param {number} modelIndex - Internal: index of model to try in chain
   * @returns {string} Generated script
   */
  static async generateScript(prompt, modelToUse = GEMINI_MODEL, modelIndex = DEFAULT_MODEL_INDEX) {
    const startTime = Date.now();
    
    try {
      // Validate API key
      const apiKey = process.env.GEMINI_API_KEY;
      
      if (!apiKey) {
        console.error('❌ Gemini API key not configured');
        throw new Error('Gemini API key not configured');
      }
      
      // Determine which model to use: either explicit override or from chain
      let selectedModel = modelToUse;
      let modelConfig = MODELS.find(m => m.model === modelToUse);
      
      // If using from chain, get model config at index
      if (modelToUse === GEMINI_MODEL && modelIndex < MODELS.length) {
        selectedModel = MODELS[modelIndex].model;
        modelConfig = MODELS[modelIndex];
      }
      
      // Fallback to v1beta if config not found
      const version = modelConfig?.version || 'v1beta';
      
      console.log('🤖 Gemini Service: Starting script generation', {
        promptLength: prompt.length,
        model: selectedModel,
        apiVersion: version,
        modelIndex: modelIndex,
        chainLength: MODELS.length
      });
      
      const apiUrl = this.getApiUrl(selectedModel);
      const response = await fetch(`${apiUrl}?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 2048,
          },
          safetySettings: [
            {
              category: "HARM_CATEGORY_HARASSMENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              category: "HARM_CATEGORY_HATE_SPEECH",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            }
          ]
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('❌ Gemini API error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorData,
          modelUsed: selectedModel,
          apiVersion: version
        });
        
        if (response.status === 401 || response.status === 403) {
          throw new Error('Invalid Gemini API key');
        }
        
        if (response.status === 404) {
          const errorMsg = errorData?.error?.message || 'Model not found';
          if (errorMsg.includes('models/')) {
            console.warn(`⚠️ Model "${selectedModel}" not available on ${version}. Trying next in chain...`);
          }
          throw new Error('Gemini API resource not found');
        }
        
        if (response.status === 429) {
          // Quota exceeded - try next model in chain
          if (modelIndex < MODELS.length - 1) {
            const nextModelName = MODELS[modelIndex + 1].model;
            console.warn(`⚠️ Quota exceeded for "${selectedModel}". Trying next model: "${nextModelName}"`);
            return this.generateScript(prompt, MODELS[modelIndex + 1].model, modelIndex + 1);
          }
          throw new Error('Gemini API quota exceeded on all models in chain');
        }
        throw new Error(`Gemini API error: ${response.status}`);
      }
      
      const responseData = await response.json();
      
      if (!responseData.candidates || responseData.candidates.length === 0) {
        console.error('❌ No response generated from Gemini API');
        throw new Error('No response generated from Gemini API');
      }
      
      const generatedText = responseData.candidates[0]?.content?.parts?.[0]?.text;
      
      if (!generatedText) {
        console.error('❌ Empty response from Gemini API');
        throw new Error('Empty response from Gemini API');
      }
      
      const processingTime = Date.now() - startTime;
      
      console.log('✅ Gemini Service: Script generation completed', {
        processingTime,
        modelUsed: selectedModel,
        responseLength: generatedText.length
      });
      
      // Clean up the response and return only the script
      return this.cleanResponse(generatedText);
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      console.error('❌ Gemini Service: Script generation failed', {
        error: error.message,
        processingTime
      });
      
      // Re-throw with specific error types
      if (error.message.includes('API key')) {
        throw new Error('AI service configuration error');
      }
      
      if (error.message.includes('quota')) {
        throw new Error('AI service quota exceeded');
      }
      
      if (error.message.includes('timeout')) {
        throw new Error('AI service timeout');
      }
      
      // Wrap all other errors as service unavailable
      console.error('❌ Critical Gemini service error:', error);
      throw new Error('AI service temporarily unavailable');
    }
  }
  
  /**
   * Clean and format the AI response
   * @param {string} response - Raw AI response
   * @returns {string} Cleaned script text
   */
  static cleanResponse(response) {
    if (!response) {
      return '';
    }
    
    // Remove any JSON formatting or code blocks
    let cleaned = response
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .replace(/^{[\s\S]*}$/g, '') // Remove JSON objects
      .replace(/^\s*[\r\n]/gm, '') // Remove empty lines at start
      .trim();
    
    // Remove any remaining technical formatting
    cleaned = cleaned
      .replace(/"script":\s*"/g, '')
      .replace(/"\s*}$/g, '')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"');
    
    return cleaned;
  }
  
  /**
   * Get safe fallback script when AI fails
   * @param {Object} data - Basic project data
   * @returns {string} Fallback script
   */
  static getFallbackScript(data = {}) {
    const { companyName = 'Your Company', domain = 'your-website.com' } = data;
    
    return `Welcome to your AI video script for ${companyName}.

After analyzing your website at ${domain}, we've identified several key areas for improvement in your SEO and AI visibility.

Your overall performance shows opportunities for enhancement in technical SEO, content optimization, and AI search readiness.

Key recommendations include optimizing your page speed, improving meta descriptions, and implementing structured data markup to better communicate with search engines.

Focus on these areas first: technical health improvements, content optimization, and AI visibility enhancements to improve your search rankings.

This analysis provides a foundation for your digital marketing strategy and continued growth in search visibility.`;
  }
  
  /**
   * Test Gemini API connection
   * @returns {boolean} Connection status
   */
  static async testConnection() {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      
      if (!apiKey) {
        return false;
      }
      
      const testPrompt = 'Respond with "OK" to test connection.';
      const response = await this.generateScript(testPrompt);
      
      return response.toLowerCase().includes('ok');
      
    } catch (error) {
      console.error('Gemini Service: Connection test failed', {
        error: error.message
      });
      
      return false;
    }
  }
}
