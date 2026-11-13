import axios from 'axios';
import { parseEnvelope } from '../services/dataForSeoRetry.js';

/**
 * The three DataForSEO Standard SERP calls (Google organic). One authenticated HTTP request each; no retries here (the service owns the
 * policy). Nothing is billed except task_post (the docs: "your account will be charged only for posting a task"); tasks_ready and
 * task_get are free. Envelope-level failures are thrown with `apiStatusCode`; HTTP failures stay axios errors.
 *
 * Limits (docs): task_post <= 100 tasks per request; tasks_ready 20 calls/minute, returns up to 1000 tasks of the last 3 days;
 * results can be fetched for 30 days.
 */

const BASE = 'https://api.dataforseo.com/v3/serp/google/organic';

const headers = () => {
  const login = process.env.DATAFORSEO_LOGIN || '';
  const password = process.env.DATAFORSEO_PASSWORD || '';
  return { Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`, 'Content-Type': 'application/json' };
};

function open(raw) {
  const data = parseEnvelope(raw);
  if (data.status_code !== 20000) {
    throw Object.assign(new Error(`DataForSEO API error: ${data.status_message ?? 'unknown'} (code ${data.status_code})`), {
      isApiError: true, apiStatusCode: data.status_code, apiStatusMessage: typeof data.status_message === 'string' ? data.status_message.slice(0, 300) : null,
    });
  }
  return data;
}

export function createStandardClient({ http = axios, timeoutMs = 60_000 } = {}) {
  return {
    /** @param {object[]} items 1..100 task_post items. @returns {Promise<{ tasks: object[], cost: number|null }>} tasks[i] answers items[i] */
    async postTasks(items) {
      if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new RangeError('task_post takes 1 to 100 tasks');
      const res = await http.post(`${BASE}/task_post`, items, { headers: headers(), timeout: timeoutMs });
      const data = open(res.data);
      return { tasks: Array.isArray(data.tasks) ? data.tasks : [], cost: Number.isFinite(data.cost) ? data.cost : null };
    },

    /** @returns {Promise<{ id: string, tag: string|null }[]>} tasks that are ready and not collected yet */
    async tasksReady() {
      const res = await http.get(`${BASE}/tasks_ready`, { headers: headers(), timeout: timeoutMs });
      const data = open(res.data);
      const out = [];
      for (const t of data.tasks ?? []) for (const r of t?.result ?? []) if (r && typeof r.id === 'string') out.push({ id: r.id, tag: r.tag ?? null });
      return out;
    },

    /** @returns {Promise<object|null>} the task object (tasks[0]) of task_get/advanced, or null when the response carries none */
    async taskGet(id) {
      const res = await http.get(`${BASE}/task_get/advanced/${encodeURIComponent(id)}`, { headers: headers(), timeout: timeoutMs });
      const data = open(res.data);
      return data.tasks?.[0] ?? null;
    },
  };
}
