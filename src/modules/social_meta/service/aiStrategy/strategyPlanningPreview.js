import { validateStrategyPlanning } from './strategyPlanning.js';
import { checkQuotaFor } from '../calendar/calendarQuotaService.js';
import { platformStates } from '../calendar/calendarPlanningContext.js';
import SeoProject from '../../../app_user/model/SeoProject.js';

/**
 * previewStrategyPlanning - what the strategy wizard shows BEFORE anything is generated: the planner's own count for the chosen frequency and
 * duration, the state of each platform's connection, and whether the calendar that follows would fit the monthly allowance. Read-only: no AI
 * call, no write, nothing reserved (creating the strategy itself uses no calendar allowance; the calendar does, when it is generated).
 *
 * Kept apart from socialAIStrategyService.js because it needs the calendar's connection and allowance helpers, and those already import the
 * strategy service.
 */
export async function previewStrategyPlanning(projectId, userId, input, { today } = {}) {
  const checked = validateStrategyPlanning(input, today ? { today } : undefined);
  if (checked.error) return { success: false, error: checked.error };
  const planning = checked.value;

  if (!(await SeoProject.exists({ _id: projectId, is_deleted: { $ne: true } }))) return { success: false, error: { code: 'NOT_FOUND', message: 'Project not found.' } };

  const [states, quota] = await Promise.all([
    platformStates(projectId),
    checkQuotaFor({ userId, projectId, posts: planning.estimatedPosts }),
  ]);
  return {
    success: true,
    preview: {
      postsPerWeek: planning.postsPerWeek,
      months: planning.months,
      platforms: planning.platforms,
      estimatedPosts: planning.estimatedPosts,
      // the count is exact for a calendar that starts on this date; a real calendar recounts from the day the person picks
      basis: { startDate: planning.basisStartDate, endDate: planning.basisEndDate, partialWeeks: planning.partialWeeks },
      platformStates: states,
      quota: quota.summary,
      quotaCheck: quota.ok ? { fits: true } : { fits: false, code: quota.error.code, message: quota.error.message },
    },
  };
}

export default { previewStrategyPlanning };
