/**
 * Data Formatting Utilities
 * Handles safe data formatting and transformation
 */

export class FormatUtils {
  
  /**
   * Safe number formatting with fallback
   * @param {*} value - Value to format
   * @param {number} fallback - Default value
   * @param {number} decimals - Decimal places (default: 0)
   * @returns {number} Formatted number
   */
  static safeNumber(value, fallback = 0, decimals = 0) {
    if (value == null || value === '' || isNaN(value) || !isFinite(value)) {
      return fallback;
    }
    
    const num = Number(value);
    return decimals > 0 ? Number(num.toFixed(decimals)) : Math.round(num);
  }

  /**
   * Format number with specified decimal places
   * @param {number} value - Number to format
   * @param {number} decimals - Decimal places
   * @returns {number} Formatted number
   */
  static formatNumber(value, decimals = 0) {
    return this.safeNumber(value, 0, decimals);
  }

  /**
   * Format percentage value
   * @param {number} value - Value (0-100)
   * @param {number} decimals - Decimal places
   * @returns {number} Formatted percentage
   */
  static formatPercentage(value, decimals = 0) {
    return this.safeNumber(value, 0, decimals);
  }

  /**
   * Format date to readable string
   * @param {Date|string} date - Date to format
   * @param {string} format - Format type ('short', 'long', 'iso')
   * @returns {string} Formatted date
   */
  static formatDate(date, format = 'short') {
    if (!date) return 'N/A';
    
    try {
      const dateObj = new Date(date);
      if (isNaN(dateObj.getTime())) return 'N/A';

      switch (format) {
        case 'short':
          return dateObj.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          });
        case 'long':
          return dateObj.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });
        case 'iso':
          return dateObj.toISOString().split('T')[0];
        default:
          return dateObj.toLocaleDateString();
      }
    } catch {
      return 'N/A';
    }
  }

  /**
   * Format duration in milliseconds to readable string
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted duration
   */
  static formatDuration(ms) {
    if (!ms || ms <= 0) return '0ms';
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Format file size
   * @param {number} bytes - Size in bytes
   * @returns {string} Formatted file size
   */
  static formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Format URL for display
   * @param {string} url - URL to format
   * @param {number} maxLength - Maximum length
   * @returns {string} Formatted URL
   */
  static formatUrl(url, maxLength = 50) {
    if (!url) return 'N/A';
    
    // Remove protocol and www
    let formatted = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
    
    // Remove trailing slash
    formatted = formatted.replace(/\/$/, '');
    
    // Truncate if too long
    if (formatted.length > maxLength) {
      formatted = formatted.substring(0, maxLength - 3) + '...';
    }
    
    return formatted;
  }

  /**
   * Format text with proper capitalization
   * @param {string} text - Text to format
   * @returns {string} Formatted text
   */
  static formatTitle(text) {
    if (!text || typeof text !== 'string') return 'N/A';
    
    return text
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Format array to safe array
   * @param {*} value - Value to convert
   * @param {Array} fallback - Default array
   * @returns {Array} Safe array
   */
  static safeArray(value, fallback = []) {
    if (Array.isArray(value)) return value;
    if (value == null) return fallback;
    return [value];
  }

  /**
   * Format object to safe object
   * @param {*} value - Value to convert
   * @param {Object} fallback - Default object
   * @returns {Object} Safe object
   */
  static safeObject(value, fallback = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    return fallback;
  }

  /**
   * Format string with fallback
   * @param {*} value - Value to format
   * @param {string} fallback - Default string
   * @returns {string} Safe string
   */
  static safeString(value, fallback = 'N/A') {
    if (value == null || value === '') return fallback;
    return String(value);
  }

  /**
   * Format boolean with fallback
   * @param {*} value - Value to format
   * @param {boolean} fallback - Default boolean
   * @returns {boolean} Safe boolean
   */
  static safeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return fallback;
  }

  /**
   * Truncate text to specified length
   * @param {string} text - Text to truncate
   * @param {number} maxLength - Maximum length
   * @param {string} suffix - Suffix to add if truncated
   * @returns {string} Truncated text
   */
  static truncate(text, maxLength = 100, suffix = '...') {
    if (!text || text.length <= maxLength) return text;
    
    return text.substring(0, maxLength - suffix.length) + suffix;
  }

  /**
   * Format snake_case to Title Case
   * @param {string} snake - Snake case string
   * @returns {string} Title case string
   */
  static snakeToTitle(snake) {
    if (!snake || typeof snake !== 'string') return '';
    
    return snake
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Format camelCase to Title Case
   * @param {string} camel - Camel case string
   * @returns {string} Title case string
   */
  static camelToTitle(camel) {
    if (!camel || typeof camel !== 'string') return '';
    
    // Insert space before capital letters
    const result = camel.replace(/([A-Z])/g, ' $1');
    return this.formatTitle(result.trim());
  }

  /**
   * Deep clone object safely
   * @param {Object} obj - Object to clone
   * @returns {Object} Cloned object
   */
  static deepClone(obj) {
    if (obj == null || typeof obj !== 'object') return obj;
    
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return {};
    }
  }

  /**
   * Remove null and undefined values from object
   * @param {Object} obj - Object to clean
   * @returns {Object} Cleaned object
   */
  static removeNullish(obj) {
    if (!obj || typeof obj !== 'object') return {};
    
    const cleaned = {};
    Object.entries(obj).forEach(([key, value]) => {
      if (value != null && value !== undefined) {
        cleaned[key] = value;
      }
    });
    
    return cleaned;
  }
}
