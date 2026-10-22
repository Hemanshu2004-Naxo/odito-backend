/**
 * breadcrumbAnalyzer — establishes (or honestly fails to establish) a page's breadcrumb hierarchy from evidence, and validates a proposed
 * BreadcrumbList against it. A structured-data ANALYZER plug-in: the engine and the master prompt know nothing about breadcrumbs.
 *
 * Hierarchy sources, strongest first:
 *   1. the page's own breadcrumb markup (visible navigation and/or JSON-LD), when it is internally consistent and ends at this page
 *   2. placement in the site's menu: a top-level item hangs off the site root; a nested item hangs off its menu parent, but only if
 *      that parent is a real page (a dropdown heading with href="#" is a label, not a page)
 *   3. URL path ancestors / "the homepage is everyone's parent" — NEVER enough on their own: they yield `inferred`, which requires review
 * Sibling pages contribute the site's convention (root label/URL) only.
 *
 * Every trail item records where its name and URL came from and whether that is verified. Parent URLs that were not otherwise fetched are
 * requested (bounded) to confirm they answer 200 without redirecting elsewhere. status: verified | inferred | unresolved.
 */

import { EVIDENCE_STATUS } from '../evidence/evidenceLedger.js';

export const normUrl = (u) => String(u || '').replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
const sameSite = (a, b) => !!hostOf(a) && hostOf(a) === hostOf(b);
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return '/'; } };
const stripSiteSuffix = (t) => String(t || '').split(/\s[|–—-]\s/)[0].trim();

/** Facts of the raw page and the rendered DOM (whichever were retrieved). */
function pageViews(ledger) {
  const views = [];
  const raw = ledger.first('page'); if (raw?.data?.facts) views.push({ label: 'raw', facts: raw.data.facts, id: raw.id });
  const ren = ledger.first('rendered_dom'); if (ren?.data?.facts) views.push({ label: 'rendered', facts: ren.data.facts, id: ren.id });
  return views;
}

function trailsFromMarkup(views) {
  const jsonLd = []; const visible = [];
  for (const v of views) {
    for (const l of v.facts.structuredData?.breadcrumbLists || []) jsonLd.push({ view: v.label, evidenceId: v.id, items: l.items.map((i) => ({ name: i.name, url: i.url || null })) });
    for (const b of v.facts.visibleBreadcrumbs || []) visible.push({ view: v.label, evidenceId: v.id, items: b.items.map((i) => ({ name: i.name, url: i.url || null, current: !!i.current })) });
  }
  return { jsonLd, visible };
}

const trailKey = (items) => items.map((i) => `${normUrl(i.url)}`).join('>');

export const breadcrumbAnalyzer = {
  id: 'breadcrumb_hierarchy',
  schemaTypes: ['BreadcrumbList'],

  appliesTo: ({ issue, plan }) => plan.family === 'structured_data' && /breadcrumb/i.test(`${issue.issueId} ${issue.title || ''}`),

  async analyze({ ledger, issue, siteUrl, fetchUrl }) {
    const views = pageViews(ledger);
    const pageItem = ledger.first('page');
    const issues = []; const unresolved = []; const derivedFrom = new Set();
    if (!views.length) {
      return { status: EVIDENCE_STATUS.UNAVAILABLE, summary: 'No page evidence to analyse the breadcrumb hierarchy from.', data: { status: 'unresolved', trail: [], issues: ['The page could not be inspected.'], unresolved: [{ kind: 'page', reason: 'No raw or rendered page evidence.' }], requiresReview: true } };
    }
    views.forEach((v) => derivedFrom.add(v.id));
    const finalUrl = pageItem?.data?.finalUrl || views[0].facts.canonicalLinks?.[0] || issue.pageUrl;
    const canonicalRaw = views.map((v) => v.facts.canonicalLinks?.[0]).find(Boolean) || null;
    const canonicalUsable = canonicalRaw && sameSite(canonicalRaw, siteUrl);
    const currentUrl = canonicalUsable ? canonicalRaw : finalUrl;
    const currentUrlSource = canonicalUsable ? 'canonical_link' : 'final_url_after_redirects';
    if (canonicalRaw && !canonicalUsable) issues.push(`The canonical URL (${canonicalRaw}) is on a different site; the fetched URL is used instead.`);
    if (canonicalRaw && normUrl(canonicalRaw) !== normUrl(finalUrl)) issues.push(`The canonical URL (${canonicalRaw}) differs from the URL the page was served at (${finalUrl}).`);
    const root = `${originOf(finalUrl)}/`;

    const homepage = ledger.first('homepage'); if (homepage) derivedFrom.add(homepage.id);
    const siblings = ledger.find('sibling').filter((s) => s.status === EVIDENCE_STATUS.OK && s.data?.facts); siblings.forEach((s) => derivedFrom.add(s.id));

    // ── existing markup ──────────────────────────────────────────────────────────────
    const markup = trailsFromMarkup(views);
    const distinctJsonLd = new Set(markup.jsonLd.map((t) => trailKey(t.items)));
    const jsonLdLists = markup.jsonLd.length;
    const flags = {
      schemaWithoutVisible: jsonLdLists > 0 && markup.visible.length === 0,
      visibleWithoutSchema: markup.visible.length > 0 && jsonLdLists === 0,
      duplicateLists: new Set(views.filter((v) => (v.facts.structuredData?.breadcrumbLists || []).length > 1).map((v) => v.label)).size > 0,
      markupConflict: false,
      jsonLdOnlyAfterJavaScript: !views.find((v) => v.label === 'raw')?.facts.structuredData?.breadcrumbLists?.length && !!views.find((v) => v.label === 'rendered')?.facts.structuredData?.breadcrumbLists?.length,
    };
    if (distinctJsonLd.size > 1) { flags.markupConflict = true; issues.push('The page outputs BreadcrumbList markup that disagrees with itself (different trails).'); }
    if (flags.duplicateLists) issues.push('The page outputs more than one BreadcrumbList.');
    if (markup.visible.length && markup.jsonLd.length) {
      const v = markup.visible[0]; const j = markup.jsonLd[0];
      const urlsV = v.items.filter((i) => i.url).map((i) => normUrl(i.url)); const urlsJ = j.items.filter((i) => i.url).map((i) => normUrl(i.url));
      if (urlsV.join('>') !== urlsJ.slice(0, urlsV.length).join('>') && urlsV.length) { flags.markupConflict = true; issues.push('The visible breadcrumb and the JSON-LD breadcrumb describe different trails.'); }
    }
    if (flags.schemaWithoutVisible) issues.push('BreadcrumbList JSON-LD exists but no breadcrumb is visible on the page, so the markup describes navigation users cannot see.');

    // convention from sibling pages
    const sibTrails = siblings.map((s) => trailsFromMarkup([{ label: 'sibling', facts: s.data.facts, id: s.id }])).map((t) => t.visible[0] || t.jsonLd[0]).filter(Boolean);
    const rootItems = sibTrails.map((t) => t.items[0]).filter((i) => i && i.url && normUrl(i.url) === normUrl(root));
    const conventions = {
      siblingTrailsSeen: sibTrails.length,
      rootFirst: sibTrails.length > 0 && rootItems.length === sibTrails.length,
      rootLabel: rootItems.length ? rootItems[0].name : null,
    };

    // ── trail ─────────────────────────────────────────────────────────────────────────
    let trail = []; let basis = null; let currentNameSource = null;
    const lastOfMarkup = (t) => t.items[t.items.length - 1];
    const markupCandidates = [...markup.visible, ...markup.jsonLd].filter((t) => t.items.length >= 2
      && t.items.every((i) => !i.url || sameSite(i.url, siteUrl))
      && (!lastOfMarkup(t).url || normUrl(lastOfMarkup(t).url) === normUrl(currentUrl)));
    const ownTrail = markupCandidates.find((t) => t.items.slice(0, -1).every((i) => i.url)) || null;

    if (ownTrail && !flags.markupConflict) {
      basis = markup.visible.includes(ownTrail) && markup.jsonLd.length ? 'page_markup_corroborated' : 'page_markup';
      trail = ownTrail.items.map((i, idx, arr) => ({
        position: idx + 1, name: i.name, url: idx === arr.length - 1 ? currentUrl : i.url,
        nameSource: `${ownTrail.view} breadcrumb markup`, urlSource: idx === arr.length - 1 ? currentUrlSource : `${ownTrail.view} breadcrumb markup`, verified: false, evidenceId: ownTrail.evidenceId,
      }));
      currentNameSource = trail[trail.length - 1].nameSource;
    } else {
      // derive from the menu
      const navSources = [];
      if (homepage?.data?.facts) navSources.push({ label: 'homepage menu', id: homepage.id, links: homepage.data.facts.navigation || [] });
      for (const v of views) navSources.push({ label: `${v.label} page menu`, id: v.id, links: v.facts.navigation || [] });
      for (const s of siblings) navSources.push({ label: 'sibling page menu', id: s.id, links: s.data.facts.navigation || [] });
      const navEntry = (url) => { for (const src of navSources) { const e = src.links.find((l) => normUrl(l.url) === normUrl(url)); if (e) return { ...e, from: src.label, evidenceId: src.id }; } return null; };
      const rootLabel = conventions.rootLabel || (navEntry(root)?.text ?? null);
      const rootLabelSource = conventions.rootLabel ? 'sibling breadcrumb convention' : (rootLabel ? 'menu link to the site root' : null);

      const upwards = []; // nearest-first
      let cursor = currentUrl; let rootVerified = false; let guard = 0;
      while (guard++ < 5) {
        const entry = navEntry(cursor);
        if (entry?.topLevel) { rootVerified = !!homepage && homepage.status === EVIDENCE_STATUS.OK && entry.from === 'homepage menu'; upwards.push({ via: 'menu_top_level', rootOfThis: true, entry }); break; }
        if (entry?.parent) {
          if (entry.parent.url && sameSite(entry.parent.url, siteUrl) && normUrl(entry.parent.url) !== normUrl(cursor)) {
            upwards.push({ via: 'menu_parent', node: { name: entry.parent.text, url: entry.parent.url, nameSource: `${entry.from} (menu parent)`, urlSource: `${entry.from} (menu parent)`, verified: false, evidenceId: entry.evidenceId } });
            cursor = entry.parent.url; continue;
          }
          unresolved.push({ kind: 'parent', reason: `${entry.parent.text ? `The menu group "${entry.parent.text}"` : 'The parent menu item'} that contains this page has no page of its own (its link is empty or "#").`, label: entry.parent.text || null });
          break;
        }
        // no menu placement: URL-path ancestor (inferred)
        const segs = pathOf(cursor).split('/').filter(Boolean);
        if (segs.length > 1) {
          const parentUrl = `${originOf(cursor)}/${segs.slice(0, -1).join('/')}/`;
          upwards.push({ via: 'url_path', node: { name: null, url: parentUrl, nameSource: null, urlSource: 'URL path ancestor (not confirmed by any menu or link)', verified: false } });
          issues.push(`The parent ${parentUrl} is only implied by the URL path.`);
          cursor = parentUrl; continue;
        }
        upwards.push({ via: 'assumed_root', rootOfThis: true });
        issues.push('No menu placement was found for this page, so the site root is only assumed to be its parent.');
        break;
      }
      const hasHole = unresolved.some((u) => u.kind === 'parent');
      if (!hasHole) {
        const mids = upwards.filter((u) => u.node).map((u) => u.node).reverse(); // root-nearest first
        const rootNode = {
          name: rootLabel || null, url: root, nameSource: rootLabelSource, urlSource: upwards.find((u) => u.rootOfThis)?.via === 'menu_top_level' ? 'top-level item of the homepage menu' : 'assumed',
          _rootVerified: rootVerified || (conventions.rootFirst && upwards.some((u) => u.via === 'menu_top_level')), verified: false, evidenceId: homepage?.id,
        };
        if (!rootNode.name) unresolved.push({ kind: 'label', reason: 'No evidence shows what this site calls its root in a breadcrumb (no "Home" link in the menu, no breadcrumb on any inspected page).', position: 1, suggestion: 'Home', suggestionBasis: 'a common convention only; nothing on this site confirms it — the owner must choose the label' });
        trail = [rootNode, ...mids].map((n, idx) => ({ position: idx + 1, ...n }));
        trail.push({ position: trail.length + 1, name: null, url: currentUrl, nameSource: null, urlSource: currentUrlSource, verified: false });
        basis = upwards.some((u) => u.via === 'url_path' || u.via === 'assumed_root') ? 'inferred_path' : 'menu_placement';
      } else basis = 'unresolved_menu_parent';
    }

    // current-page label: visible current crumb > H1 > title without site suffix
    if (trail.length && !trail[trail.length - 1].name) {
      const v = views[views.length - 1].facts;
      const h1 = (v.headings || []).find((h) => h.level === 1)?.text;
      const cur = trail[trail.length - 1];
      if (h1) { cur.name = h1; cur.nameSource = 'page H1'; } else if (v.title) { cur.name = stripSiteSuffix(v.title); cur.nameSource = 'page title (site name removed)'; }
      if (!cur.name) unresolved.push({ kind: 'label', reason: 'The page has neither an H1 nor a title to name the current breadcrumb item.', position: trail.length });
    }
    // parents without a usable label: use the URL's last segment ONLY as a flagged placeholder, never as a verified name
    for (const n of trail.slice(0, -1)) {
      if (!n.name && n.url && !unresolved.some((u) => u.kind === 'label' && u.position === n.position)) { unresolved.push({ kind: 'label', reason: `No evidence for the label of ${n.url}.`, position: n.position }); }
    }

    // ── URL checks for parents not already fetched ───────────────────────────────────────
    const checkedUrls = [];
    const alreadyChecked = (u) => ledger.items.find((i) => i.status && i.url && normUrl(i.url) === normUrl(u) && ['page', 'homepage', 'sibling', 'hierarchy_url'].includes(i.kind));
    let budget = 4;
    for (const n of trail.slice(0, -1)) {
      if (!n.url) continue;
      let item = alreadyChecked(n.url);
      if (!item && budget > 0) { budget -= 1; item = await fetchUrl(n.url); }
      if (!item) { checkedUrls.push({ url: n.url, ok: false, reason: 'not checked (limit reached)' }); n.verified = false; continue; }
      derivedFrom.add(item.id);
      const finalOk = item.status === EVIDENCE_STATUS.OK && (!item.data?.finalUrl || normUrl(item.data.finalUrl) === normUrl(n.url));
      checkedUrls.push({ url: n.url, ok: finalOk, status: item.httpStatus ?? null, finalUrl: item.data?.finalUrl || null, evidenceId: item.id });
      if (!finalOk) issues.push(`${n.url} ${item.status === EVIDENCE_STATUS.OK ? `redirects to ${item.data?.finalUrl}` : `could not be confirmed (${item.error?.code || item.status})`}.`);
    }
    // A level is verified only if: its name AND URL come from evidence (not a path guess / assumption), the URL answered 200 without redirecting
    // elsewhere, and — for the root — the page is a top-level item of the homepage menu (or the page's own markup says so).
    const live = new Map(checkedUrls.map((c) => [normUrl(c.url), c.ok]));
    for (const n of trail) {
      if (n.position === trail.length) { n.verified = !!n.name; continue; }
      const backed = !!n.name && !!n.nameSource && !/not confirmed|assumed/.test(n.urlSource || '');
      const liveOk = live.get(normUrl(n.url)) !== false;
      if (String(basis).startsWith('page_markup')) n.verified = backed && liveOk;
      else if (n.position === 1) n.verified = backed && liveOk && n._rootVerified === true;
      else n.verified = backed && liveOk;
    }
    trail = trail.map(({ _rootVerified, ...rest }) => rest);

    const allVerified = trail.length >= 2 && trail.every((n) => n.verified) && !unresolved.length && !flags.markupConflict;
    const status = !trail.length || unresolved.some((u) => u.kind === 'parent') ? 'unresolved' : allVerified ? 'verified' : 'inferred';
    const data = {
      status, basis, trail, currentUrl, currentUrlSource, existing: {
        jsonLdLists, visibleTrails: markup.visible.length, jsonLdTrails: markup.jsonLd.slice(0, 3).map((t) => ({ view: t.view, items: t.items })), visibleTrailItems: markup.visible.slice(0, 2).map((t) => ({ view: t.view, items: t.items })),
      },
      flags, conventions, issues, unresolved, checkedUrls, requiresReview: status !== 'verified',
    };
    return {
      status: EVIDENCE_STATUS.OK, derivedFrom: [...derivedFrom],
      summary: `Breadcrumb hierarchy ${status}${basis ? ` (${basis.replace(/_/g, ' ')})` : ''}: ${trail.map((n) => n.name || '?').join(' > ') || 'no trail'}${unresolved.length ? ` — ${unresolved.length} unresolved` : ''}.`,
      data,
    };
  },

  /** Checks a proposed BreadcrumbList node against the analysis. Returns safety checks; `passed:false` ones block automatic application. */
  validateProposal({ node, analysis }) {
    const checks = [];
    const items = [].concat(node?.itemListElement || []).map((el) => ({ name: String(el?.name ?? el?.item?.name ?? '').trim(), url: typeof el?.item === 'string' ? el.item : (el?.item?.['@id'] || el?.item?.url || null) }));
    const a = analysis?.data;
    if (!a) { checks.push({ name: 'breadcrumb_hierarchy_analysed', passed: false, detail: 'The hierarchy could not be analysed from the available evidence.' }); return { checks, requiresReview: true }; }
    const trailUrls = a.trail.map((n) => normUrl(n.url));
    checks.push({
      name: 'breadcrumb_hierarchy_verified', passed: a.status === 'verified',
      detail: a.status === 'verified' ? 'Every level of the trail is backed by evidence.' : `Hierarchy is ${a.status}: ${[...a.unresolved.map((u) => u.reason), ...a.issues].slice(0, 4).join(' ')}`,
    });
    const strays = items.filter((i) => i.url && !trailUrls.includes(normUrl(i.url)));
    checks.push({ name: 'breadcrumb_urls_in_hierarchy', passed: strays.length === 0, detail: strays.length ? `Proposed URL(s) not in the analysed hierarchy: ${strays.map((s) => s.url).join(', ')}` : 'Every proposed URL is a level of the analysed hierarchy.' });
    const last = items[items.length - 1];
    checks.push({ name: 'breadcrumb_last_is_current_page', passed: !!last && (!last.url || normUrl(last.url) === normUrl(a.currentUrl)), detail: last?.url && normUrl(last.url) !== normUrl(a.currentUrl) ? `The last item (${last.url}) is not the page's canonical URL (${a.currentUrl}).` : 'The last item is the current page.' });
    checks.push({ name: 'breadcrumb_length_matches_hierarchy', passed: items.length === a.trail.length, detail: items.length === a.trail.length ? 'Same number of levels as the analysed hierarchy.' : `Proposal has ${items.length} levels, the analysed hierarchy ${a.trail.length}.` });
    const unreachable = a.checkedUrls.filter((c) => !c.ok);
    checks.push({ name: 'breadcrumb_parent_urls_reachable', passed: unreachable.length === 0, detail: unreachable.length ? `Not confirmed reachable: ${unreachable.map((u) => u.url).join(', ')}` : 'Every parent URL answered without redirecting elsewhere.' });
    const nameMismatch = items.filter((i, idx) => a.trail[idx]?.name && i.name && i.name !== a.trail[idx].name);
    checks.push({ name: 'breadcrumb_labels_match_evidence', passed: nameMismatch.length === 0, detail: nameMismatch.length ? `Labels differ from the evidenced ones: ${nameMismatch.map((i) => `"${i.name}"`).join(', ')}` : 'Labels match the evidenced ones.' });
    return { checks, requiresReview: checks.some((c) => !c.passed) };
  },
};

export default breadcrumbAnalyzer;
