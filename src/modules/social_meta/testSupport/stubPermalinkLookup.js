/**
 * Test-only: replaces the Facebook adapter's post-publish permalink lookup with a stub that answers "no permalink", so a test
 * that substitutes the adapter's publish() can never reach the real Graph API through the lookup that follows a successful
 * publish. Import it for its side effect. Tests that exercise the lookup itself stub metaApiService.request instead and
 * restore `getPermalink` from the real adapter module.
 */
import adapters from '../service/platformAdapters/index.js';

adapters.facebook.getPermalink = async () => ({ permalink: null, code: 'TEST_STUB' });
