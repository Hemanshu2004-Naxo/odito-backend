import { OAuth2Client } from 'google-auth-library';
import GoogleConnection, { encryptToken } from '../modules/app_user/model/GoogleConnection.js';

/**
 * Google API Service - Centralized Token Management
 * 
 * Responsibilities:
 * - Validate token expiry
 * - Refresh access tokens using refresh_token
 * - Update tokens in database
 * - Provide valid access tokens for Google API calls
 * 
 * Security Notes:
 * - Never logs actual tokens
 * - Never returns refresh_token to callers
 * - Uses 5-minute safety buffer for token expiry
 */

// Safety buffer: refresh tokens 5 minutes before expiry
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// OAuth2 client for token operations
const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

/**
 * Check if access token is expired or near expiry
 * @param {Date} tokenExpiresAt - Token expiry timestamp
 * @returns {boolean} - True if token needs refresh
 */
function isTokenExpired(tokenExpiresAt) {
  if (!tokenExpiresAt) {
    console.log('[GOOGLE_API] No expiry timestamp found - token needs refresh');
    return true;
  }

  const now = new Date();
  const expiryTime = new Date(tokenExpiresAt);
  const bufferTime = new Date(expiryTime.getTime() - TOKEN_EXPIRY_BUFFER_MS);
  
  const isExpired = now >= bufferTime;
  
  if (isExpired) {
    console.log('[GOOGLE_API] Token expired or near expiry', {
      now: now.toISOString(),
      expiresAt: expiryTime.toISOString(),
      bufferTime: bufferTime.toISOString()
    });
  }
  
  return isExpired;
}

/**
 * Refresh access token using refresh_token
 * @param {string} refreshToken - Refresh token from GoogleConnection
 * @returns {Promise<Object>} - New token set from Google
 */
async function refreshAccessToken(refreshToken) {
  try {
    console.log('[GOOGLE_API] Refreshing access token');
    
    // Set refresh token and get new tokens
    oauth2Client.setCredentials({
      refresh_token: refreshToken
    });
    
    const tokenResponse = await oauth2Client.refreshAccessToken();
    const tokens = tokenResponse.credentials;
    
    if (!tokens.access_token) {
      throw new Error('No access_token received from Google refresh');
    }
    
    console.log('[GOOGLE_API] Token refresh successful', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
    });
    
    return tokens;
    
  } catch (error) {
    console.error('[GOOGLE_API] Token refresh failed', {
      error: error.message,
      code: error.code,
      status: error.status
    });
    
    // Re-throw with context
    throw new Error(`Google token refresh failed: ${error.message}`);
  }
}

/**
 * Update GoogleConnection with new tokens
 * @param {string} connectionId - Connection document ID
 * @param {Object} tokens - New token set from Google
 * @returns {Promise<Object>} - Updated connection document
 */
async function updateConnectionTokens(connectionId, tokens) {
  try {
    const updateData = {
      access_token: encryptToken(tokens.access_token),
      updated_at: new Date()
    };

    // Update expiry date if provided
    if (tokens.expiry_date) {
      updateData.token_expires_at = new Date(tokens.expiry_date);
    }

    // Update refresh token if Google provided a new one
    if (tokens.refresh_token) {
      updateData.refresh_token = encryptToken(tokens.refresh_token);
    }
    
    const updatedConnection = await GoogleConnection.findByIdAndUpdate(
      connectionId,
      { $set: updateData },
      { new: true, runValidators: true }
    );
    
    if (!updatedConnection) {
      throw new Error('GoogleConnection not found during token update');
    }
    
    console.log('[GOOGLE_API] Connection tokens updated successfully', {
      connectionId,
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      newExpiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
    });
    
    return updatedConnection;
    
  } catch (error) {
    console.error('[GOOGLE_API] Failed to update connection tokens', {
      connectionId,
      error: error.message
    });
    
    throw new Error(`Failed to update connection tokens: ${error.message}`);
  }
}

/**
 * Mark connection as expired in database
 * @param {string} connectionId - Connection document ID
 * @param {string} reason - Why connection was marked expired
 */
async function markConnectionExpired(connectionId, reason = 'Token refresh failed') {
  try {
    await GoogleConnection.findByIdAndUpdate(
      connectionId,
      { 
        $set: {
          status: 'expired',
          updated_at: new Date()
        }
      }
    );
    
    console.log('[GOOGLE_API] Connection marked as expired', {
      connectionId,
      reason
    });
    
  } catch (error) {
    console.error('[GOOGLE_API] Failed to mark connection as expired', {
      connectionId,
      error: error.message
    });
    // Don't throw - this is cleanup, not critical path
  }
}

/**
 * Get valid access token for Google API calls
 * 
 * This is the main entry point for all Google services.
 * It handles token validation, refresh, and database updates.
 * 
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {Promise<string>} - Valid access token
 * @throws {Error} - If token cannot be obtained
 */
export async function getValidAccessToken(googleConnection) {
  // Validate input
  if (!googleConnection) {
    throw new Error('GoogleConnection document is required');
  }
  
  if (!googleConnection.refresh_token) {
    const err = new Error('GoogleConnection missing refresh_token');
    err.code = 'GOOGLE_TOKEN_REFRESH_FAILED';
    throw err;
  }
  
  const connectionId = googleConnection._id?.toString();
  if (!connectionId) {
    throw new Error('GoogleConnection missing valid _id');
  }
  
  // Check if current token is valid
  if (!isTokenExpired(googleConnection.token_expires_at) && googleConnection.access_token) {
    console.log('[GOOGLE_API] Using existing valid access token', {
      connectionId,
      expiresAt: googleConnection.token_expires_at?.toISOString()
    });
    
    return googleConnection.access_token;
  }
  
  // Token needs refresh
  console.log('[GOOGLE_API] Access token expired or missing, refreshing', {
    connectionId,
    currentExpiresAt: googleConnection.token_expires_at?.toISOString(),
    hasAccessToken: !!googleConnection.access_token
  });
  
  try {
    // Refresh the token
    const newTokens = await refreshAccessToken(googleConnection.refresh_token);
    
    // Update database with new tokens
    await updateConnectionTokens(connectionId, newTokens);
    
    // Return new access token
    return newTokens.access_token;
    
  } catch (error) {
    console.error('[GOOGLE_API] Failed to get valid access token', {
      connectionId,
      error: error.message
    });
    
    // Mark connection as expired for user visibility
    await markConnectionExpired(connectionId, error.message);
    
    // Re-throw for caller to handle. The code lets controllers answer
    // "reconnect your Google account" instead of a generic 500.
    const err = new Error(`Failed to obtain valid access token: ${error.message}`);
    err.code = 'GOOGLE_TOKEN_REFRESH_FAILED';
    throw err;
  }
}

/**
 * Same token lookup/refresh as getValidAccessToken, but a failed refresh does
 * NOT mark the connection expired - it just throws an error tagged
 * `code = 'GOOGLE_TOKEN_REFRESH_FAILED'`.
 *
 * For callers whose failure must not flip shared connection state (the review
 * reply write: a refresh blip, timeout or Google outage shouldn't disconnect
 * the whole Business Profile). getValidAccessToken itself is unchanged.
 * Successful refreshes are still persisted, exactly as before.
 *
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {Promise<string>} - Valid access token
 */
export async function getAccessTokenWithoutStatusChange(googleConnection) {
  if (!googleConnection?.refresh_token || !googleConnection._id) {
    const err = new Error('GoogleConnection is missing credentials');
    err.code = 'GOOGLE_TOKEN_REFRESH_FAILED';
    throw err;
  }

  if (!isTokenExpired(googleConnection.token_expires_at) && googleConnection.access_token) {
    return googleConnection.access_token;
  }

  try {
    const newTokens = await refreshAccessToken(googleConnection.refresh_token);
    await updateConnectionTokens(googleConnection._id.toString(), newTokens);
    return newTokens.access_token;
  } catch (error) {
    console.error('[GOOGLE_API] Token refresh failed (connection status left unchanged)', {
      connectionId: googleConnection._id.toString(),
      error: error.message
    });
    const err = new Error('Failed to obtain a valid Google access token');
    err.code = 'GOOGLE_TOKEN_REFRESH_FAILED';
    throw err;
  }
}

/**
 * Create OAuth2 client with valid access token
 *
 * Utility function for Google API clients.
 * Automatically handles token refresh and client setup.
 * 
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {Promise<OAuth2Client>} - Configured OAuth2 client
 */
export async function createAuthenticatedClient(googleConnection) {
  const accessToken = await getValidAccessToken(googleConnection);
  
  const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  
  client.setCredentials({
    access_token: accessToken
  });
  
  return client;
}

/**
 * Validate GoogleConnection is ready for API calls
 * 
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {boolean} - True if connection is valid
 */
export function isValidConnection(googleConnection) {
  return !!(
    googleConnection &&
    googleConnection._id &&
    googleConnection.refresh_token &&
    googleConnection.status === 'active'
  );
}

export default {
  getValidAccessToken,
  getAccessTokenWithoutStatusChange,
  createAuthenticatedClient,
  isValidConnection
};
