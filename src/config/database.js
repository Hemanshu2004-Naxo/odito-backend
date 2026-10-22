import mongoose from 'mongoose';

/** mongodb://user:secret@host:27017/db?x=1 -> mongodb://***@host:27017/db (credentials and query string removed) */
export const redactMongoUri = (uri) => String(uri || '').replace(/^(mongodb(?:\+srv)?:\/\/)[^@/]*@/i, '$1***@').replace(/\?.*$/, '');

const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGO_URI;
    console.log(`--- Attempting to connect to MongoDB (${redactMongoUri(mongoURI)}) ---`);
    // MONGO_DB_NAME pins the database explicitly. The Python workers write
    // seo_* collections (e.g. seo_audit_url_pool) straight into Mongo and must
    // use the SAME database this backend reads — set the same MONGO_DB_NAME in
    // python_workers/.env. Without it, a URI lacking a /dbname path makes
    // Mongoose fall back to "test" while the workers fall back to "odito_dev".
    const explicitDbName = process.env.MONGO_DB_NAME || undefined;
    const conn = await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      ...(explicitDbName ? { dbName: explicitDbName } : {}),
    });
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    console.log(`🔗 Connected to MongoDB database: ${conn.connection.name}`);
    const uriHasDbPath = /^mongodb(\+srv)?:\/\/[^/]+\/[^/?]+/.test(mongoURI);
    if (!explicitDbName && !uriHasDbPath) {
      console.warn(
        `⚠️  MONGO_URI has no database name and MONGO_DB_NAME is not set — using the driver default "${conn.connection.name}". ` +
        'Python workers default to "odito_dev"; if the two differ, worker-written data (seo_audit_url_pool, seo_page_data, …) will be invisible to this backend. ' +
        'Set MONGO_DB_NAME (same value) in both odito_backend/.env and python_workers/.env.'
      );
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
