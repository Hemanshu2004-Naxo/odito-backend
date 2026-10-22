/**
 * Groq AI Service
 * Handles integration with Groq API for AI script generation
 * Primary AI provider with intelligent model fallback chain
 */

import Groq from 'groq-sdk';

// Model fallback chain: Try each model in order until one succeeds
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',   // Primary: Versatile, high quality
  'mixtral-8x7b-32768',         // Secondary: Fast, balanced
  'llama3-8b-8192'              // Tertiary: Light, reliable fallback
];

const DEFAULT_MODEL = GROQ_MODELS[0]; // Start with llama-3.3-70b-versatile

export class GroqService {
  static instance = null;
  static currentModelIndex = 0;  // Track which model in chain we're using

  /**
   * Get or initialize Groq client
   * @returns {Groq} Groq client instance
   */
  static getClient() {
    if (!this.instance) {
      const apiKey = process.env.GROQ_API_KEY;
      
      if (!apiKey) {
        console.error('❌ Groq API key not configured in environment');
        throw new Error('Groq API key not configured');
      }

      this.instance = new Groq({
        apiKey: apiKey,
      });
    }
    return this.instance;
  }

  /**
   * Generate video script using Groq API with model fallback chain
   * Tries models in priority order: llama-3.3-70b → mixtral-8x7b → llama3-8b
   * @param {string} prompt - AI prompt for script generation
   * @param {number} modelIndex - Internal: index of model to try in chain
   * @returns {Object} Generated script result
   */
  static async generateScript(prompt, modelIndex = 0) {
    const startTime = Date.now();
    
    try {
      if (!prompt || typeof prompt !== 'string') {
        throw new Error('Invalid prompt: must be a non-empty string');
      }

      const selectedModel = GROQ_MODELS[modelIndex] || DEFAULT_MODEL;

      console.log('🤖 Groq Service: Starting script generation', {
        promptLength: prompt.length,
        model: selectedModel,
        modelIndex: modelIndex,
        chainLength: GROQ_MODELS.length
      });

      const groq = this.getClient();

      const message = await groq.chat.completions.create({
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        model: selectedModel,
        temperature: 0.7,
        max_tokens: 2048,
        top_p: 0.95,
        stream: false,
      });

      if (!message?.choices?.[0]?.message?.content) {
        console.error('❌ Empty response from Groq API');
        throw new Error('Empty response from Groq API');
      }

      const generatedText = message.choices[0].message.content;
      const processingTime = Date.now() - startTime;

      console.log('✅ Groq Service: Script generation completed', {
        processingTime,
        responseLength: generatedText.length,
        model: selectedModel
      });

      return {
        success: true,
        script: this.cleanResponse(generatedText),
        processingTime,
        provider: 'groq',
        model: selectedModel
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      const selectedModel = GROQ_MODELS[modelIndex] || DEFAULT_MODEL;

      console.error('❌ Groq Service: Script generation failed', {
        error: error.message,
        processingTime,
        model: selectedModel,
        modelIndex: modelIndex,
        type: error.constructor.name
      });

      // Try next model in chain if available
      if (modelIndex < GROQ_MODELS.length - 1) {
        const nextModel = GROQ_MODELS[modelIndex + 1];
        console.warn(`⚠️ Model "${selectedModel}" failed. Trying next: "${nextModel}"`);
        return this.generateScript(prompt, modelIndex + 1);
      }

      // All models exhausted - return error
      let errorType = 'unknown';
      
      if (error.message?.includes('API key')) {
        errorType = 'auth_error';
      } else if (error.message?.includes('quota') || error.status === 429) {
        errorType = 'quota_exceeded';
      } else if (error.message?.includes('timeout') || error.status === 504) {
        errorType = 'timeout';
      } else if (error.status === 500 || error.status === 503) {
        errorType = 'service_unavailable';
      }

      return {
        success: false,
        error: {
          message: error.message,
          type: errorType,
          processingTime
        }
      };
    }
  }

  /**
   * Clean and format the AI response
   * @param {string} response - Raw AI response
   * @returns {string} Cleaned script text
   */
  static cleanResponse(response) {
    if (!response || typeof response !== 'string') {
      return '';
    }

    let cleaned = response
      // Remove markdown code blocks
      .replace(/```[\w]*\n?/g, '')
      // Remove JSON wrappers
      .replace(/^{[\s\S]*}$/g, '')
      // Remove extra whitespace
      .replace(/^\s+|\s+$/g, '')
      .trim();

    return cleaned;
  }

  /**
   * Validate Groq API is accessible
   * Tries each model in the chain
   * @returns {boolean} True if API is accessible
   */
  static async validateConnection() {
    try {
      console.log('🔍 Groq Service: Validating API connection with model chain...');
      
      const groq = this.getClient();
      
      // Try each model in the chain
      for (let i = 0; i < GROQ_MODELS.length; i++) {
        const model = GROQ_MODELS[i];
        try {
          console.log(`  Testing model: ${model}`);
          
          const testMessage = await groq.chat.completions.create({
            messages: [
              {
                role: 'user',
                content: 'Say hello'
              }
            ],
            model: model,
            max_tokens: 10,
          });

          const isValid = !!testMessage?.choices?.[0]?.message?.content;
          
          if (isValid) {
            console.log(`✅ Groq Service: API connection validated with model "${model}"`);
            return true;
          }
        } catch (modelError) {
          console.warn(`⚠️ Model "${model}" not available: ${modelError.message}`);
          continue;
        }
      }

      console.error('❌ Groq Service: No models available for validation');
      return false;

    } catch (error) {
      console.error('❌ Groq Service: API connection validation failed', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Test Groq with sample script generation
   * Tests all models in the chain
   * @returns {Object} Test result
   */
  static async test() {
    try {
      console.log('🧪 Groq Service: Running test with model chain...');
      
      const testPrompt = 'Generate a short professional subject line for an email.';
      const result = await this.generateScript(testPrompt);

      return {
        success: result.success,
        message: result.success ? 'Groq service is operational' : 'Groq service failed',
        model: result.model,
        sample: result.script || result.error?.message,
        models: GROQ_MODELS
      };

    } catch (error) {
      return {
        success: false,
        message: 'Groq service test failed',
        error: error.message,
        models: GROQ_MODELS
      };
    }
  }

  /**
   * Get available models
   * @returns {Array} List of Groq models in chain
   */
  static getAvailableModels() {
    return GROQ_MODELS;
  }

  /**
   * Get primary model
   * @returns {string} Primary model name
   */
  static getPrimaryModel() {
    return DEFAULT_MODEL;
  }
}

export default GroqService;
