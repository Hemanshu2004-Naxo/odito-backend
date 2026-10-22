<?php
/**
 * Odito_Divi_Capture
 *
 * Server-side Divi contact form submission capture.
 *
 * ============================================================================
 * MECHANISM — confirmed against a real production capture (Sapphire, the
 * "Become a Partner" form), not guessed.
 * ============================================================================
 * A real Chrome DevTools capture of this form's submission showed a direct
 * POST to the page itself (`/become-a-partner/`), not a call to
 * `admin-ajax.php`. This plugin's first Divi capture attempt assumed an
 * AJAX action (`wp_ajax_et_pb_submit_form`) — that was wrong, which is
 * exactly why it never fired; Divi simply never calls that action for
 * this submission path.
 *
 * There is no WordPress or Divi action/filter for "a same-page POST just
 * arrived" — that's not an event, it's just how the request carries data.
 * Divi's own module code reads $_POST directly during its own normal
 * request handling (its redirect-on-success behavior, confirmed working
 * on the real site, must run on or before `template_redirect` — nothing
 * can redirect after theme output has started). So instead of guessing at
 * a private Divi hook name, this observes the same $_POST data WordPress
 * core's own `init` action already has available, at the earliest
 * reasonably possible point in the request lifecycle: `init` fires
 * strictly before `wp` and `template_redirect`, so this is guaranteed to
 * run before whatever later hook Divi uses to redirect. See odito.php's
 * `add_action( 'init', 'odito_init', 1 )` — priority 1, not the default
 * 10, specifically so nothing else hooked on `init` at a later priority
 * can have already exited first.
 *
 * The real capture also confirmed the field-key convention
 * (`et_pb_contact_<slug>_<index>`) and, more valuably, revealed
 * `et_pb_contact_email_fields_<index>` — a JSON blob Divi itself embeds
 * mapping each field's key to its `original_id`/`field_label`. That's
 * used as the primary source for human-readable field names; the
 * previous approach (matching against Odito_Forms's synced field list)
 * is kept only as a fallback if that metadata is ever absent or
 * unparseable.
 * ============================================================================
 *
 * Same pure-observer guarantee as CF7 capture: never throws out of this
 * file, never modifies $_POST, never calls wp_die()/exit()/emits output.
 * A bug here can produce silence (no lead captured) but cannot break the
 * visitor's actual Divi form submission, email, or redirect.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Odito_Divi_Capture {

	/**
	 * The exact marker confirmed present on a real Divi submission
	 * (et_pb_contactform_submit_0 = et_contact_process) — the strongest,
	 * most specific available signal that a request is a genuine Divi
	 * contact-form submission, checked before doing anything else so this
	 * is effectively free on the overwhelming majority of requests (every
	 * page view, every unrelated POST) where it's simply absent.
	 */
	const SUBMIT_MARKER_PATTERN = '/^et_pb_contactform_submit_(\d+)$/';

	/** Divi's own submission field-key convention — confirmed against the real capture. */
	const FIELD_KEY_PATTERN = '/^et_pb_contact_(.+)_(\d+)$/';

	/**
	 * Divi-internal control keys that would otherwise match
	 * FIELD_KEY_PATTERN but are never real submitted fields — must be
	 * excluded structurally, not just by sensitive-field filtering (a
	 * captcha answer isn't "sensitive" in the password/PII sense, but
	 * it's not a business field either).
	 */
	const EXCLUDED_SLUGS = array( 'captcha', 'email_fields' );

	/** Short window for the duplicate-submission guard — see maybe_reject_duplicate(). */
	const DUPLICATE_GUARD_SECONDS = 60;

	public static function init() {
		try {
			self::maybe_capture();
		} catch ( \Throwable $e ) {
			// Defensive catch-all: whatever went wrong in OUR code must
			// never propagate into WordPress's own request handling.
			self::log( 'error', 'unhandled exception during capture: ' . $e->getMessage() );
		}
	}

	private static function maybe_capture() {
		// Cheapest possible checks first — this runs on EVERY request
		// (page views, REST calls, cron, everything), so the non-matching
		// case (the overwhelming majority) must be near-free.
		if ( empty( $_SERVER['REQUEST_METHOD'] ) || 'POST' !== $_SERVER['REQUEST_METHOD'] ) {
			return;
		}

		$submit_index = self::find_submit_marker( $_POST ); // phpcs:ignore WordPress.Security.NonceVerification.Missing -- pure observer; see file header.
		if ( null === $submit_index ) {
			return; // Not a Divi contact-form submission — fail silently, as required.
		}

		if ( ! Odito_Connection::is_connected() ) {
			return;
		}

		self::log( 'info', 'submission detected' );

		$raw_fields = self::extract_raw_fields( $_POST, $submit_index ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		if ( empty( $raw_fields ) ) {
			self::log( 'warning', 'submit marker present but no et_pb_contact_* fields found for index ' . $submit_index );
			return;
		}

		$post_id = self::resolve_submitting_post_id();
		if ( ! $post_id ) {
			self::log( 'warning', 'could not resolve the submitting page from the referrer — aborting, nothing safe to match against' );
			return;
		}

		$form = self::resolve_form( $post_id, $raw_fields );
		if ( ! $form ) {
			self::log( 'warning', 'no synced Divi form found on post ' . (int) $post_id . ' to match this submission against' );
			return;
		}

		self::log( 'info', 'form resolved: ' . $form['externalId'] );

		$label_map = self::parse_embedded_field_metadata( $_POST, $submit_index ); // phpcs:ignore WordPress.Security.NonceVerification.Missing

		$fields = self::filter_and_map_fields( $raw_fields, $form, $label_map );
		if ( empty( $fields ) ) {
			self::log( 'warning', 'all submitted fields were filtered out (sensitive or empty) — nothing to send' );
			return;
		}

		self::log( 'info', 'fields extracted (' . count( $fields ) . ' non-sensitive field(s)): ' . implode( ', ', array_keys( $fields ) ) );

		if ( self::is_probable_duplicate( $form['externalId'], $fields ) ) {
			self::log( 'info', 'skipped — identical submission to this form seen in the last ' . self::DUPLICATE_GUARD_SECONDS . 's' );
			return;
		}

		$page_url = get_permalink( $post_id );
		if ( empty( $page_url ) ) {
			$page_url = home_url();
		}

		$payload = array(
			'eventId' => wp_generate_uuid4(),
			'form'    => array(
				'externalId' => $form['externalId'],
				'provider'   => 'divi',
				'name'       => $form['name'],
				'pageUrl'    => $page_url,
			),
			'submission' => array(
				'fields' => $fields,
			),
			'context' => array(
				'pageUrl'  => $page_url,
				'referrer' => self::resolve_absolute_referer(),
			),
		);

		self::log( 'info', 'submission queued for delivery, eventId=' . $payload['eventId'] );

		$result = Odito_Submission_Dispatcher::dispatch( $payload );

		if ( $result['success'] ) {
			self::log( 'info', 'API request successful' );
		} else {
			self::log( 'warning', 'API request failed, status=' . ( null !== $result['status'] ? $result['status'] : 'network_error' ) );
		}
	}

	// ── Submission detection & field extraction ──────────────────────────

	/** Returns the form index (e.g. "0") if a genuine Divi submit marker is present, else null. */
	private static function find_submit_marker( $post_data ) {
		foreach ( $post_data as $key => $value ) {
			if ( preg_match( self::SUBMIT_MARKER_PATTERN, $key, $matches ) ) {
				return $matches[1];
			}
		}
		return null;
	}

	/**
	 * Returns [ field_slug => raw_value ] for every $_POST key matching
	 * Divi's contact-field convention for THIS form's index, excluding
	 * Divi's own control fields (captcha, the email_fields metadata blob
	 * itself, nonces, referer) even though some of those would otherwise
	 * match the general pattern.
	 */
	private static function extract_raw_fields( $post_data, $submit_index ) {
		$fields = array();
		foreach ( $post_data as $key => $value ) {
			if ( ! preg_match( self::FIELD_KEY_PATTERN, $key, $matches ) ) {
				continue;
			}
			$slug  = $matches[1];
			$index = $matches[2];

			if ( $index !== $submit_index ) {
				continue; // A different form instance's fields on the same page.
			}
			if ( in_array( strtolower( $slug ), self::EXCLUDED_SLUGS, true ) ) {
				continue;
			}

			if ( is_array( $value ) ) {
				$value = implode( ', ', array_map( 'strval', $value ) );
			}
			$value = is_scalar( $value ) ? trim( wp_unslash( (string) $value ) ) : '';
			if ( '' === $value ) {
				continue;
			}
			$fields[ $slug ] = $value;
		}
		return $fields;
	}

	/**
	 * Divi's own embedded field metadata (et_pb_contact_email_fields_<n>)
	 * — the authoritative source for "what is this field actually called"
	 * when present. Defensively tolerant of shape: tries a JSON array of
	 * {field_id, original_id, field_label} objects (the documented shape
	 * for this metadata), falls back to an empty map (triggering the
	 * Odito_Forms-based fallback in filter_and_map_fields()) on anything
	 * that doesn't parse as expected — never trusts unverified structure
	 * blindly.
	 */
	private static function parse_embedded_field_metadata( $post_data, $submit_index ) {
		$key = 'et_pb_contact_email_fields_' . $submit_index;
		if ( empty( $post_data[ $key ] ) || ! is_string( $post_data[ $key ] ) ) {
			return array();
		}

		$decoded = json_decode( wp_unslash( $post_data[ $key ] ), true );
		if ( ! is_array( $decoded ) ) {
			return array();
		}

		$map = array();
		foreach ( $decoded as $entry ) {
			if ( ! is_array( $entry ) || empty( $entry['original_id'] ) ) {
				continue;
			}
			$slug  = (string) $entry['original_id'];
			$label = ! empty( $entry['field_label'] ) ? (string) $entry['field_label'] : $slug;
			$map[ self::slugify( $slug ) ] = $label;
		}
		return $map;
	}

	/** Referrer -> post ID via WordPress core's own resolver (real, stable API — not a guess). */
	/**
	 * Confirmed against the real capture: Divi's own submission includes
	 * `_wp_http_referer` as a RELATIVE path ("/become-a-partner/") in the
	 * POST body itself, and wp_get_referer() prefers that
	 * ($_REQUEST['_wp_http_referer']) over the absolute Referer HTTP
	 * header — but url_to_postid() cannot resolve a bare relative path
	 * (silently returns 0). Verified locally: identical setup, the
	 * relative value fails, the raw HTTP_REFERER header value succeeds.
	 * Prefers an absolute URL from either source; only falls back to
	 * prepending home_url() to a relative value as a last resort.
	 */
	private static function resolve_submitting_post_id() {
		$referer = self::resolve_absolute_referer();
		return $referer ? (int) url_to_postid( $referer ) : 0;
	}

	/**
	 * The best available ABSOLUTE referer URL, preferring the raw
	 * HTTP_REFERER header (always absolute) over wp_get_referer() (which
	 * prefers $_REQUEST['_wp_http_referer'] — a RELATIVE path on a real
	 * Divi submission, confirmed against the real capture), falling back
	 * to making a relative value absolute via home_url() only as a last
	 * resort. Shared by post-ID resolution and the context.referrer sent
	 * to Odito (a relative value there would just be nulled out anyway by
	 * the backend's own URL validation, so resolving it properly here is
	 * strictly better, not just a workaround for post-ID matching).
	 */
	private static function resolve_absolute_referer() {
		$candidates = array(
			isset( $_SERVER['HTTP_REFERER'] ) ? $_SERVER['HTTP_REFERER'] : '', // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.MissingUnslash
			wp_get_referer(),
		);

		foreach ( $candidates as $candidate ) {
			if ( ! empty( $candidate ) && preg_match( '#^https?://#i', $candidate ) ) {
				return $candidate;
			}
		}
		foreach ( $candidates as $candidate ) {
			if ( ! empty( $candidate ) ) {
				return home_url( $candidate );
			}
		}
		return null;
	}

	/**
	 * Matches the submission to one of the Divi forms Odito_Forms already
	 * knows about on this page (the exact same parsing sync uses — see
	 * class-odito-forms.php::find_divi_forms_in_post()), not a second,
	 * separately-maintained form-identity system. Required regardless of
	 * how field labels are resolved, since that's how a submission maps
	 * to a synced externalId — and how multiple Divi forms on a site (not
	 * just "Become a Partner") are supported without hardcoding any of
	 * them.
	 */
	private static function resolve_form( $post_id, $raw_fields ) {
		$candidates = Odito_Forms::find_divi_forms_in_post( $post_id );
		if ( empty( $candidates ) ) {
			return null;
		}
		if ( 1 === count( $candidates ) ) {
			return $candidates[0];
		}

		$submitted_slugs = array_map( array( __CLASS__, 'slugify' ), array_keys( $raw_fields ) );

		$best_index = 0;
		$best_score = -1;
		foreach ( $candidates as $index => $candidate ) {
			$score = 0;
			foreach ( $candidate['fields'] as $field ) {
				$candidate_slug = self::slugify( ! empty( $field['raw_field_id'] ) ? $field['raw_field_id'] : $field['name'] );
				if ( in_array( $candidate_slug, $submitted_slugs, true ) ) {
					++$score;
				}
			}
			if ( $score > $best_score ) {
				$best_score = $score;
				$best_index = $index;
			}
		}

		return $candidates[ $best_index ];
	}

	private static function slugify( $value ) {
		$value = strtolower( trim( (string) $value ) );
		return preg_replace( '/[^a-z0-9]+/', '_', $value );
	}

	/**
	 * Maps each raw submitted field to its human-readable name. Prefers
	 * Divi's own embedded metadata ($label_map, from
	 * parse_embedded_field_metadata()) when available; falls back to
	 * matching against the matched form's synced field list (the
	 * approach used before the embedded metadata was known to exist);
	 * falls back to the raw slug if neither source recognizes it (a field
	 * added to the live form since the last sync is still captured, not
	 * silently dropped).
	 *
	 * Sensitive-field filtering reuses Odito_Security::is_sensitive_field()
	 * — the exact same check CF7 capture and form-structure sync both use;
	 * no second, divergent sensitive-field implementation for Divi.
	 */
	private static function filter_and_map_fields( $raw_fields, $form, $label_map ) {
		$known_by_slug = array();
		foreach ( $form['fields'] as $field ) {
			$candidate_slug = self::slugify( ! empty( $field['raw_field_id'] ) ? $field['raw_field_id'] : $field['name'] );
			$known_by_slug[ $candidate_slug ] = $field['name'];
		}

		$fields = array();
		foreach ( $raw_fields as $slug => $value ) {
			$normalized = self::slugify( $slug );
			if ( isset( $label_map[ $normalized ] ) ) {
				$label = $label_map[ $normalized ];
			} elseif ( isset( $known_by_slug[ $normalized ] ) ) {
				$label = $known_by_slug[ $normalized ];
			} else {
				$label = $slug;
			}

			if ( Odito_Security::is_sensitive_field( $label ) || Odito_Security::is_sensitive_field( $slug ) ) {
				continue;
			}

			$fields[ $label ] = $value;
		}

		return $fields;
	}

	// ── Duplicate protection ─────────────────────────────────────────────

	/**
	 * A short-TTL WordPress transient keyed by a hash of (form + the exact
	 * non-sensitive field values already filtered above) — NOT a global or
	 * static in-process flag. Content-keyed rather than session/user-keyed
	 * on purpose: two DIFFERENT visitors submitting the same form with
	 * different answers never collide (different hash); the SAME visitor
	 * submitting the same form again minutes later is allowed once the
	 * transient expires. Only an exact repeat of the same values to the
	 * same form within the same short window is treated as a probable
	 * duplicate.
	 */
	private static function is_probable_duplicate( $external_id, $fields ) {
		$key = 'odito_divi_dup_' . md5( $external_id . '|' . wp_json_encode( $fields ) );
		if ( false !== get_transient( $key ) ) {
			return true;
		}
		set_transient( $key, 1, self::DUPLICATE_GUARD_SECONDS );
		return false;
	}

	// ── Logging ───────────────────────────────────────────────────────────

	/**
	 * [DIVI_CAPTURE] structured, PII-free debug logging — gated behind
	 * WP_DEBUG. Never logs field VALUES, only field NAMES/counts/ids/status codes.
	 */
	private static function log( $level, $message ) {
		if ( ! defined( 'WP_DEBUG' ) || ! WP_DEBUG ) {
			return;
		}
		error_log( sprintf( '[DIVI_CAPTURE] [%s] %s', strtoupper( $level ), $message ) );
	}
}
