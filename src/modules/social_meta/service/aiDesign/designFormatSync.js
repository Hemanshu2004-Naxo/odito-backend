import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import { calendarFormatAfter } from './concept/designFormat.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * After a design is attached: the content calendar must show the format that was actually made. A carousel made for an item planned
 * as a photo turns the item into 'carousel'; a single image made for an item planned as a carousel (the person chose it) turns it into
 * 'static_post'. Reel / video / text items keep their format for a single image (the still is part of that plan). Only the item the
 * post was written from, inside the post's own project, and only its `format` field. Never throws (the design is already attached).
 */
export async function syncPlannedFormat(pub, designFormat) {
  try {
    const itemId = pub?.generation?.calendarItemId;
    if (!itemId) return null;
    const item = await SocialContentCalendarItem.findOne({ _id: itemId, project_id: pub.project_id }).select('format').lean();
    const next = calendarFormatAfter(designFormat, item?.format || null);
    if (!next) return null;
    const r = await SocialContentCalendarItem.updateOne({ _id: itemId, project_id: pub.project_id, format: item.format }, { $set: { format: next } });
    if (r.modifiedCount) LoggerUtil.info('[SOCIAL_AI_DESIGN] calendar_format_synced', { event: 'calendar_format_synced', projectId: String(pub.project_id), publicationId: String(pub._id), calendarItemId: String(itemId), from: item.format, to: next });
    return r.modifiedCount ? next : null;
  } catch (error) {
    LoggerUtil.warn('[SOCIAL_AI_DESIGN] calendar_format_sync_failed', { event: 'calendar_format_sync_failed', message: error?.message || null });
    return null;
  }
}
