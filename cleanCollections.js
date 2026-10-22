import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const cleanCollections = async () => {
  try {
    // Connect to MongoDB
    const mongoURI = process.env.MONGO_URI;
    console.log(`Connecting to MongoDB: ${mongoURI}`);
    
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    console.log('✅ Connected to MongoDB');
    
    // Get all collections
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    
    console.log(`Found ${collections.length} collections:`);
    collections.forEach(col => console.log(`  - ${col.name}`));
    
    // Collections to exclude (preserve these)
    const excludeCollections = ['users', 'app_users'];
    
    // Clean collections (except users)
    for (const collection of collections) {
      if (!excludeCollections.includes(collection.name)) {
        console.log(`🧹 Cleaning collection: ${collection.name}`);
        
        try {
          const result = await db.collection(collection.name).deleteMany({});
          console.log(`   ✅ Deleted ${result.deletedCount} documents from ${collection.name}`);
        } catch (error) {
          console.error(`   ❌ Error cleaning ${collection.name}:`, error.message);
        }
      } else {
        console.log(`⏭️  Skipping collection: ${collection.name} (preserved)`);
      }
    }
    
    console.log('\n🎉 Collection cleaning completed!');
    
    // Show remaining documents in preserved collections
    console.log('\n📊 Preserved collections status:');
    for (const collectionName of excludeCollections) {
      try {
        const count = await db.collection(collectionName).countDocuments();
        console.log(`  - ${collectionName}: ${count} documents`);
      } catch (error) {
        console.log(`  - ${collectionName}: Collection not found`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error during collection cleaning:', error.message);
  } finally {
    // Close connection
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
  }
};

// Run the cleaning process
cleanCollections().catch(console.error);


