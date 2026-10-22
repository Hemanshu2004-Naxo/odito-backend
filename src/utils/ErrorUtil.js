/**
 * Error Utility - Typed Error Creation
 * Eliminates error creation duplication across 30+ service files
 */
export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
    this.type = 'NOT_FOUND';
    this.response = { 
      success: false, 
      message: message 
    };
  }
}

export class AccessDeniedError extends Error {
  constructor(message = 'Access denied') {
    super(message);
    this.name = 'AccessDeniedError';
    this.statusCode = 403;
    this.type = 'ACCESS_DENIED';
    this.response = { 
      success: false, 
      message: message 
    };
  }
}

export class ValidationError extends Error {
  constructor(message = 'Validation failed', details = null) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.type = 'VALIDATION_ERROR';
    this.details = details;
    this.response = { 
      success: false, 
      message: message,
      details: details
    };
  }
}

export class ConflictError extends Error {
  constructor(message = 'Resource conflict') {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
    this.type = 'CONFLICT';
    this.response = { 
      success: false, 
      message: message 
    };
  }
}

export class InternalServerError extends Error {
  constructor(message = 'Internal server error') {
    super(message);
    this.name = 'InternalServerError';
    this.statusCode = 500;
    this.type = 'INTERNAL_ERROR';
    this.response = { 
      success: false, 
      message: message 
    };
  }
}

export class ServiceUnavailableError extends Error {
  constructor(message = 'Service temporarily unavailable') {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.statusCode = 503;
    this.type = 'SERVICE_UNAVAILABLE';
    this.response = { 
      success: false, 
      message: message 
    };
  }
}

/**
 * Error Utility Factory
 * Provides centralized error creation methods
 */
export class ErrorUtil {
  
  /**
   * Create project not found error
   */
  static projectNotFound() {
    return new NotFoundError('Project not found');
  }

  /**
   * Create access denied error
   */
  static accessDenied() {
    return new AccessDeniedError('Access denied');
  }

  /**
   * Create validation error with details
   */
  static validation(message, details = null) {
    return new ValidationError(message, details);
  }

  /**
   * Create resource conflict error
   */
  static conflict(message) {
    return new ConflictError(message);
  }

  /**
   * Create internal server error
   */
  static internal(message = 'Internal server error') {
    return new InternalServerError(message);
  }

  /**
   * Create service unavailable error
   */
  static unavailable(message = 'Service temporarily unavailable') {
    return new ServiceUnavailableError(message);
  }

  /**
   * Handle unknown errors and convert to appropriate type
   */
  static handleUnknown(error, defaultMessage = 'An unexpected error occurred') {
    if (error.type && error.statusCode) {
      // Already a typed error
      return error;
    }

    // Convert common error patterns
    if (error.name === 'CastError' || error.name === 'ValidationError') {
      return new ValidationError('Invalid input data', error.message);
    }

    if (error.name === 'MongoServerError' && error.code === 11000) {
      return new ConflictError('Resource already exists');
    }

    // Default to internal server error
    const internalError = new InternalServerError(defaultMessage);
    internalError.originalError = error;
    return internalError;
  }
}
