import mongoose from 'mongoose';

/**
 * Test fixture: a minimal SeoProject row, so publishing code that (correctly) refuses to act for a project that does not
 * exist can be exercised with a plain ObjectId. Inserted through the raw collection (no schema defaults, no side effects) and
 * removed by removeProject. `trashed` makes it a soft-deleted project, as the trash does.
 */
const collection = () => mongoose.connection.db.collection('seoprojects');

export async function ensureProject(projectId, { userId = null, trashed = false } = {}) {
  const _id = new mongoose.Types.ObjectId(String(projectId));
  await collection().updateOne(
    { _id },
    { $setOnInsert: { _id, user_id: userId ? new mongoose.Types.ObjectId(String(userId)) : new mongoose.Types.ObjectId(), project_name: `fixture-${String(_id)}`, createdAt: new Date() }, $set: { is_deleted: !!trashed } },
    { upsert: true },
  );
  return _id;
}

export async function setProjectTrashed(projectId, trashed = true) {
  await collection().updateOne({ _id: new mongoose.Types.ObjectId(String(projectId)) }, { $set: { is_deleted: !!trashed } });
}

export async function removeProject(projectId) {
  await collection().deleteOne({ _id: new mongoose.Types.ObjectId(String(projectId)) });
}
