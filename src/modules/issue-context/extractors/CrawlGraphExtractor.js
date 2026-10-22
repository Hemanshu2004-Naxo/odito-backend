import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;

/**
 * CrawlGraphExtractor
 *
 * Fetches crawl graph metrics and link data for redirect chains,
 * broken links, click depth, and orphan detection.
 *
 * seo_crawl_graph schema (written by crawl_graph_worker.py):
 *   { url, inboundLinks, outboundLinks, clickDepthFromHomepage, isOrphan, analyzedAt }
 *
 * seo_internal_links schema (written by link_discovery.py):
 *   { url (target), sourceUrl (source), seo_jobId, projectId, discoveredAt }
 */
export class CrawlGraphExtractor {
  constructor() {
    this.name = 'crawl_graph';
  }

  async extract(projectId, pageUrl) {
    const db = mongoose.connection.db;
    const projectIdObj = new ObjectId(projectId);

    const [crawlData, outboundLinks, inboundLinks] = await Promise.all([
      // ── Crawl graph record for this specific URL ──────────────────────────
      // Worker writes "url" field (not "page_url").
      // Worker writes "inboundLinks", "clickDepthFromHomepage" (not click_depth / inbound_link_count).
      // redirect_chain, broken_links etc. are NOT written by the worker — kept in projection
      // for legacy fallback; MongoDB returns them as undefined (no-op).
      db.collection('seo_crawl_graph').findOne(
        { projectId: projectIdObj, url: pageUrl },
        {
          projection: {
            url: 1,
            inboundLinks: 1,
            outboundLinks: 1,
            clickDepthFromHomepage: 1,
            isOrphan: 1,
            // Legacy / redirect fields (not written by current worker; kept for future use)
            redirect_chain: 1,
            redirect_loop: 1,
            broken_links: 1,
            redirecting_links: 1,
            nofollow_links: 1,
            status_code: 1,
            error_pages_4xx: 1,
            error_pages_5xx: 1,
            timeout: 1,
          },
        }
      ),

      // ── Outbound links: pages this URL links TO ───────────────────────────
      // seo_internal_links stores sourceUrl (origin) + url (destination).
      // Query by sourceUrl = this page to get outbound internal links.
      db.collection('seo_internal_links')
        .find({ projectId: projectIdObj, sourceUrl: pageUrl })
        .project({ url: 1, _id: 0 })
        .limit(50)
        .toArray(),

      // ── Inbound links: pages that link TO this URL ────────────────────────
      // Query by url = this page to find which pages link here.
      // Used by orphan_pages to show potential linking pages.
      db.collection('seo_internal_links')
        .find({ projectId: projectIdObj, url: pageUrl })
        .project({ sourceUrl: 1, _id: 0 })
        .limit(20)
        .toArray(),
    ]);

    return {
      crawlData,
      // outboundLinks: [{ url: targetUrl }, ...]
      outboundLinks,
      // inboundLinks: [{ sourceUrl: sourcePageUrl }, ...]
      inboundLinks,
      // Legacy alias kept so existing code paths that access `internalLinks` still compile
      internalLinks: outboundLinks,
    };
  }
}

export default new CrawlGraphExtractor();
