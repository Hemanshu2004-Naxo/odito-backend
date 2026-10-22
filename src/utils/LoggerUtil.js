/**
 * Logger Utility - Structured Logging
 * Replaces all console.log with structured, searchable logging
 */
/**
 * Defence in depth: whatever a caller puts in a log line, credentials do not reach the log. Values of keys that name a secret (token, password,
 * authorization, cookie, api key, client secret, ...) are replaced, and well-known secret shapes inside any string (Bearer tokens,
 * access_token=..., connection-string passwords, Anthropic / OpenAI / Meta token prefixes) are masked. Counters such as inputTokens / outputTokens
 * are not secrets and are untouched. Callers should still never pass a credential.
 */
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|bearer|client_?secret|app_?secret|api_?key|x-api-key|private_?key|access_?token|refresh_?token|id_?token|fb_exchange_token|long_?lived_?token|page_?token)$/i;
const SENSITIVE_SUFFIX = /(secret|password|api_?key|access_?token|refresh_?token)$/i;
const SECRET_PATTERNS = [
  [/(Bearer\s+)[A-Za-z0-9\-._~+/]{8,}=*/gi, '$1' + REDACTED],
  [/\b((?:access|refresh|id)_token|client_secret|app_secret|api[_-]?key|fb_exchange_token|password)=([^&\s"'<>]+)/gi, '$1=' + REDACTED],
  [/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, '$1' + REDACTED + '@'],
  [/\bsk-ant-[A-Za-z0-9\-_]{10,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9]{24,}/g, REDACTED],
  [/\bEAA[A-Za-z0-9]{24,}/g, REDACTED],
];
const MAX_REDACT_DEPTH = 8;

export function redactString(text) {
  let out = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function redactForLog(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (typeof value.toJSON === 'function') return value; // Date, ObjectId, ...: serialised by JSON.stringify itself
  if (depth >= MAX_REDACT_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    // a boolean cannot hold a secret: presence flags such as hasAccessToken: true are kept (they are how code logs "a token existed" safely)
    const named = SENSITIVE_KEY.test(key) || SENSITIVE_SUFFIX.test(key);
    out[key] = named && inner !== null && inner !== undefined && typeof inner !== 'boolean' ? REDACTED : redactForLog(inner, depth + 1);
  }
  return out;
}

export class LoggerUtil {
  
  /**
   * Get current timestamp in ISO format
   * @returns {string} ISO timestamp
   */
  static getTimestamp() {
    return new Date().toISOString();
  }

  /**
   * Create log entry structure
   * @param {string} level - Log level (info, warn, error, debug)
   * @param {string} message - Log message
   * @param {Object} context - Additional context data
   * @returns {Object} Structured log entry
   */
  static createLogEntry(level, message, context = {}) {
    return {
      timestamp: this.getTimestamp(),
      level: level.toUpperCase(),
      message: redactString(message),
      ...redactForLog(context)
    };
  }

  /**
   * Info level logging
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   */
  static info(message, context = {}) {
    const logEntry = this.createLogEntry('info', message, context);
    console.log(JSON.stringify(logEntry));
  }

  /**
   * Warning level logging
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   */
  static warn(message, context = {}) {
    const logEntry = this.createLogEntry('warn', message, context);
    console.warn(JSON.stringify(logEntry));
  }

  /**
   * Error level logging
   * @param {string} message - Log message
   * @param {Error|Object} error - Error object or details
   * @param {Object} context - Additional context
   */
  static error(message, error = {}, context = {}) {
    // For Axios (and any HTTP-client) errors, error.response carries the
    // actual remote status/body/headers — dropping it here (as this used
    // to) meant every caller's error log showed only name/message/stack,
    // never the real reason a 3rd-party API rejected the request (e.g. a
    // missing required parameter, which HTTP 400/422 bodies explain but
    // Error.message alone does not).
    const errorDetails = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
      type: error.type || 'UNKNOWN',
      ...(error.response ? {
        responseStatus: error.response.status,
        responseData: error.response.data,
      } : {})
    } : error;

    const logEntry = this.createLogEntry('error', message, {
      ...context,
      error: errorDetails
    });

    console.error(JSON.stringify(logEntry));
  }

  /**
   * Debug level logging
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   */
  static debug(message, context = {}) {
    if (process.env.NODE_ENV === 'development' || process.env.LOG_LEVEL === 'debug') {
      const logEntry = this.createLogEntry('debug', message, context);
      console.log(JSON.stringify(logEntry));
    }
  }

  /**
   * Service operation logging
   * @param {string} serviceName - Service name
   * @param {string} operation - Operation name
   * @param {string} status - Operation status (started, completed, failed)
   * @param {Object} context - Additional context
   */
  static service(serviceName, operation, status, context = {}) {
    const message = `${serviceName}.${operation} ${status}`;
    this.info(message, {
      service: serviceName,
      operation: operation,
      status: status,
      ...context
    });
  }

  /**
   * Database operation logging
   * @param {string} operation - DB operation (query, aggregate, update)
   * @param {string} collection - Collection name
   * @param {number} duration - Operation duration in ms
   * @param {Object} context - Additional context
   */
  static database(operation, collection, duration = null, context = {}) {
    const message = `DB ${operation} on ${collection}`;
    const logContext = {
      operation: operation,
      collection: collection,
      ...context
    };

    if (duration !== null) {
      logContext.duration = `${duration}ms`;
    }

    this.info(message, logContext);
  }

  /**
   * API request logging
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {string} userId - User ID
   * @param {number} statusCode - Response status code
   * @param {number} duration - Request duration in ms
   */
  static api(method, endpoint, userId, statusCode, duration) {
    this.info('API Request', {
      method: method,
      endpoint: endpoint,
      userId: userId,
      statusCode: statusCode,
      duration: `${duration}ms`
    });
  }

  /**
   * Job operation logging
   * @param {string} jobId - Job ID
   * @param {string} jobType - Job type
   * @param {string} status - Job status
   * @param {Object} context - Additional context
   */
  static job(jobId, jobType, status, context = {}) {
    const message = `Job ${jobType} ${status}`;
    this.info(message, {
      jobId: jobId,
      jobType: jobType,
      status: status,
      ...context
    });
  }

  /**
   * Performance logging
   * @param {string} operation - Operation name
   * @param {number} duration - Duration in ms
   * @param {Object} context - Additional context
   */
  static performance(operation, duration, context = {}) {
    const message = `Performance: ${operation}`;
    this.info(message, {
      operation: operation,
      duration: `${duration}ms`,
      ...context
    });
  }

  /**
   * Security event logging
   * @param {string} event - Security event type
   * @param {string} userId - User ID
   * @param {Object} context - Additional context
   */
  static security(event, userId, context = {}) {
    const message = `Security Event: ${event}`;
    this.warn(message, {
      event: event,
      userId: userId,
      ...context
    });
  }
}
