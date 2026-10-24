import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

/**
 * Isolated database for AI Visibility integration tests. The name is forced (never the dev/prod database from MONGO_URI) and
 * the helper refuses to connect to anything else. Tests self-skip when MongoDB is not reachable.
 */
export const TEST_DB = process.env.AI_VISIBILITY_IT_DB || 'odito_ai_visibility_it';

export function testMongoUri() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
  return /\/[^/?]+(\?|$)/.test(uri.replace(/^mongodb(\+srv)?:\/\//, ''))
    ? uri.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB}$2`)
    : uri.replace(/\/?(\?|$)/, `/${TEST_DB}$1`);
}

/** @returns {Promise<boolean>} true when connected to the isolated database */
export async function connectTestDb() {
  if (!/_it$|_test$/i.test(TEST_DB)) throw new Error(`Refusing to use database "${TEST_DB}": not an isolated test database name.`);
  try {
    await mongoose.connect(testMongoUri(), { serverSelectionTimeoutMS: 2000 });
  } catch {
    return false;
  }
  if (mongoose.connection.name !== TEST_DB) {
    await mongoose.disconnect();
    throw new Error('Connected to an unexpected database.');
  }
  return true;
}

export async function disconnectTestDb() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

export async function dropTestCollections(names) {
  for (const n of names) {
    try { await mongoose.connection.db.collection(n).deleteMany({}); } catch { /* collection may not exist yet */ }
  }
}
