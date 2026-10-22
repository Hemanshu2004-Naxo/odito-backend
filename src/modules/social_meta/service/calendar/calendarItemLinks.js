import mongoose from 'mongoose';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import SocialPublication from '../../model/SocialPublication.js';

/**
 * The two places a calendar item and a publication meet, kept in a tiny module (models only) so the content generator
 * can import it without a cycle with the calendar item service, which itself starts content generation.
 *
 *   linkPublicationToItem      "this draft came from this plan item": records the reference and moves the PLANNING status
 *                              to content_generated. It never touches the publication, its approval state or its schedule,
 *                              and it can only add a reference inside the item's own project.
 *   loadPublicationSummaries   read-only: the state of the linked publications, which is the source of truth for everything
 *                              after "content generated" (review, approval, scheduling, publishing).
 */
const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
const PRE_CONTENT = ['planned', 'edited', 'plan_approved', 'draft'];

export async function linkPublicationToItem({ projectId, itemId, publicationId }) {
  // ONE atomic update (a pipeline): the reference, the planning status and the revision move together, so a reader never
  // sees a linked publication on an item that still says "plan approved".
  const linked = await SocialContentCalendarItem.updateOne(
    { _id: toId(itemId), project_id: toId(projectId) },
    [{
      $set: {
        publicationIds: { $setUnion: [{ $ifNull: ['$publicationIds', []] }, [toId(publicationId)]] },
        status: { $cond: [{ $in: ['$status', PRE_CONTENT] }, 'content_generated', '$status'] },
        revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
      },
    }],
  );
  return linked.matchedCount > 0;
}

/** Map<publicationId, { id, platform, status, approvalState, content }> for publications of THIS project only. */
export async function loadPublicationSummaries(projectId, publicationIds) {
  const ids = [...new Set((publicationIds || []).map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const out = new Map();
  if (!ids.length) return out;
  const docs = await SocialPublication.find({ _id: { $in: ids }, project_id: toId(projectId) }).select('platform status approvalState content scheduledAt').lean();
  for (const d of docs) {
    out.set(String(d._id), { id: String(d._id), platform: d.platform, status: d.status, approvalState: d.approvalState ?? null, content: d.content || '', scheduledAt: d.scheduledAt ? new Date(d.scheduledAt).toISOString() : null });
  }
  return out;
}

export default { linkPublicationToItem, loadPublicationSummaries };
