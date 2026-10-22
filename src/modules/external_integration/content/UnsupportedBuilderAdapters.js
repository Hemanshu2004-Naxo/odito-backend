import { ContentAdapter, CONTENT_UNSUPPORTED } from './ContentAdapter.js';

/**
 * Builders Odito can RECOGNISE but does not yet change. Each one only detects its format and
 * answers `supported: false` with a precise reason, so:
 *   - the UI never offers "Apply via WordPress" for a page it cannot change safely, and
 *   - the reason names the builder instead of a generic "not supported".
 *
 * They exist as separate classes (not one catch-all) so that adding real support for one is a
 * contained change: implement getH1Context/addH1/updateH1/verifyH1 on that class, add tests
 * against real content of that builder, and nothing else moves. Support is not claimed for
 * any builder until that has been done and tested.
 */

function unsupported(builder, label, why) {
  return {
    supported: false,
    builder,
    state: 'unknown',
    code: CONTENT_UNSUPPORTED.BUILDER_NOT_SUPPORTED,
    reason: `This page is built with ${label}. Odito cannot change ${why} safely yet, so H1 changes are not applied automatically.`,
  };
}

export class ElementorAdapter extends ContentAdapter {
  get name() { return 'elementor'; }
  get label() { return 'Elementor'; }

  canHandle(page) {
    return page?.meta?._elementor_edit_mode === 'builder'
      || /\belementor(-page|-template)?\b/.test(page?.rendered?.bodyClass || '')
      || /data-elementor-type=/.test(page?.content?.raw || '');
  }

  getH1Context() { return unsupported('elementor', 'Elementor', 'Elementor page data'); }
}

export class GutenbergAdapter extends ContentAdapter {
  get name() { return 'gutenberg'; }
  get label() { return 'Gutenberg (block editor)'; }

  canHandle(page) {
    const raw = page?.content?.raw || '';
    return /<!--\s*wp:(?!divi\/)[a-z0-9-]+(\/[a-z0-9-]+)?/i.test(raw);
  }

  getH1Context() { return unsupported('gutenberg', 'the block editor (Gutenberg)', 'block content'); }
}

/** Classic editor / plain HTML content: deliberately never edited — see ContentAdapter. */
export class GenericHtmlAdapter extends ContentAdapter {
  get name() { return 'generic_html'; }
  get label() { return 'Classic editor / HTML'; }

  canHandle() { return true; }

  getH1Context() { return unsupported('generic_html', 'the classic editor or custom HTML', 'free-form HTML content'); }
}

export default { ElementorAdapter, GutenbergAdapter, GenericHtmlAdapter };
