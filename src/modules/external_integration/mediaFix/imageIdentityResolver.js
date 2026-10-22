/**
 * imageIdentityResolver — the I/O half of image identity: reads the media library through the core adapter and hands what it
 * found to the pure evaluateIdentity(). Nothing here writes, and no remote image URL is ever fetched: observed URLs are only
 * COMPARED with the file paths WordPress itself lists for each attachment.
 */

import { attachmentExactPaths, evaluateIdentity, hostKey, searchTermFor } from './imageIdentity.js';

const MAX_SEARCH_PAGES = 2; // 200 candidates: a search narrows by file-name stem; exact equality still decides

export async function resolveImageIdentity({ adapter, snapshot, siteUrl }) {
  const siteHost = hostKey(siteUrl);
  let hinted = null;
  let candidates = [];

  if (snapshot?.wpAttachmentId != null) {
    hinted = await adapter.readMediaById(snapshot.wpAttachmentId);
  } else {
    const term = searchTermFor(snapshot);
    if (term) {
      for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
        const batch = await adapter.searchMedia(term, page);
        candidates.push(...batch);
        if (batch.length < 100) break;
      }
    }
  }

  const verdict = evaluateIdentity({ snapshot, siteHost, hinted, candidates });
  if (verdict.status !== 'resolved') return verdict;

  const media = hinted || candidates.find((m) => m.id === verdict.attachmentId);
  return { ...verdict, media, exactPaths: [...attachmentExactPaths(media)] };
}

export default { resolveImageIdentity };
