<?php
/**
 * Odito_Cf7_Capture
 *
 * Server-side Contact Form 7 submission capture — structure-only detection
 * (class-odito-forms.php) is Phase 3A; this is the Phase 3B addition that
 * reads actual submitted VALUES, once, at the moment CF7 has validated the
 * submission and is about to process it.
 *
 * Hook: `wpcf7_before_send_mail( $contact_form, &$abort, $submission )`.
 * This fires only after CF7's own validation has passed and before mail
 * is sent — the right point to capture "a real submission happened" data.
 * We never assume the exact hook signature is fixed forever: the callback
 * declares all 3 args but only strictly needs $contact_form for the form
 * id; the actual submitted data is read via
 * `WPCF7_Submission::get_instance()`, CF7's own singleton accessor, which
 * is more robust across CF7 versions than relying on hook argument shape.
 *
 * CRITICAL (Section 17 of the Phase 3B spec): this hook NEVER sets $abort
 * and never throws — it is a pure observer. If Odito is unreachable, slow,
 * or returns an error, the customer's form still sends mail exactly as it
 * would have with this plugin deactivated. Every call into Odito_Api is
 * wrapped so a failure here can only result in a queued retry, never a
 * broken customer form.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Odito_Cf7_Capture {

	public static function init() {
		add_action( 'wpcf7_before_send_mail', array( __CLASS__, 'capture' ), 10, 3 );
	}

	public static function capture( $contact_form, &$abort, $submission ) {
		try {
			self::capture_internal( $contact_form, $abort );
		} catch ( \Throwable $e ) {
			// A defensive catch-all: whatever went wrong in OUR code must
			// never propagate up into CF7's own mail-sending flow.
			return;
		}
	}

	private static function capture_internal( $contact_form, $abort ) {
		if ( $abort ) {
			// Something else (e.g. Akismet-for-CF7, a validation edge case)
			// already decided this submission shouldn't proceed — don't
			// capture it as a lead either.
			return;
		}
		if ( ! Odito_Connection::is_connected() ) {
			return;
		}
		if ( ! class_exists( 'WPCF7_Submission' ) ) {
			return;
		}

		$submission_instance = WPCF7_Submission::get_instance();
		if ( ! $submission_instance ) {
			return;
		}

		$posted_data = $submission_instance->get_posted_data();
		if ( ! is_array( $posted_data ) || empty( $posted_data ) ) {
			return;
		}

		$page_url = $submission_instance->get_meta( 'url' );
		if ( empty( $page_url ) ) {
			$page_url = home_url();
		}

		list( $fields, $utm ) = self::filter_and_split_fields( $posted_data );

		$form_id = method_exists( $contact_form, 'id' ) ? $contact_form->id() : $contact_form->id;
		$form_title = method_exists( $contact_form, 'title' ) ? $contact_form->title() : '';

		$payload = array(
			'eventId' => wp_generate_uuid4(),
			'form'    => array(
				'externalId' => 'cf7-' . $form_id,
				'provider'   => 'contact_form_7',
				'name'       => $form_title ? $form_title : ( 'Contact Form 7 #' . $form_id ),
				'pageUrl'    => $page_url,
			),
			'submission' => array(
				'fields' => $fields,
			),
			'context' => array_merge(
				array(
					'pageUrl'  => $page_url,
					'referrer' => wp_get_referer() ? wp_get_referer() : null,
				),
				$utm
			),
		);

		self::send_with_fallback( $payload );
	}

	/**
	 * Splits CF7's posted data into (a) safe submission fields and (b) any
	 * UTM values already present as form fields (e.g. a CF7 hidden field
	 * configured with `[hidden utm_source default:get]`, a standard CF7
	 * pattern for capturing query-string values into the form itself —
	 * Section 26 requires only capturing UTM data that's already available
	 * this way, never inventing/injecting it from elsewhere).
	 *
	 * Excludes: every sensitive-named field (Odito_Security), and every
	 * CF7-internal control field — CF7's own convention is that all of its
	 * internal/meta fields are prefixed with an underscore
	 * (_wpcf7, _wpcf7_version, _wpcf7_unit_tag, _wpnonce, _wp_http_referer,
	 * etc.), so excluding any key starting with `_` is a robust,
	 * version-independent way to drop them all without hand-listing every
	 * one — plus the well-known non-underscored `g-recaptcha-response`.
	 */
	private static function filter_and_split_fields( $posted_data ) {
		$fields = array();
		$utm = array();
		$utm_key_map = array(
			'utm_source'   => 'utmSource',
			'utm_medium'   => 'utmMedium',
			'utm_campaign' => 'utmCampaign',
			'utm_term'     => 'utmTerm',
			'utm_content'  => 'utmContent',
		);

		foreach ( $posted_data as $key => $value ) {
			if ( 0 === strpos( $key, '_' ) ) {
				continue;
			}
			if ( 'g-recaptcha-response' === $key ) {
				continue;
			}
			if ( Odito_Security::is_sensitive_field( $key ) ) {
				continue;
			}
			if ( is_array( $value ) ) {
				$value = implode( ', ', array_map( 'strval', $value ) );
			}
			$value = is_scalar( $value ) ? trim( (string) $value ) : '';
			if ( '' === $value ) {
				continue;
			}

			$normalized_key = strtolower( $key );
			if ( isset( $utm_key_map[ $normalized_key ] ) ) {
				$utm[ $utm_key_map[ $normalized_key ] ] = $value;
				continue;
			}

			$fields[ $key ] = $value;
		}

		return array( $fields, $utm );
	}

	/**
	 * Section 18: "Do NOT retry synchronously multiple times inside the
	 * form request" — delegates the actual send/classify/queue-on-failure
	 * decision to Odito_Submission_Dispatcher (shared with Divi capture;
	 * see that file — same rules, same behavior as before this was
	 * extracted out of this class).
	 */
	private static function send_with_fallback( $payload ) {
		Odito_Submission_Dispatcher::dispatch( $payload );
	}

	/**
	 * WP-Cron callback (registered in odito.php) — processes due retries.
	 * Reuses the same short submission timeout and the same success/permanent/
	 * temporary classification as the initial synchronous attempt.
	 */
	public static function process_queue() {
		if ( ! Odito_Connection::is_connected() ) {
			return;
		}

		// claim_due_items() atomically claims rows (status -> 'processing'
		// with a leased claim token) so a second, overlapping WP-Cron run
		// can never also pick up the same row — see class-odito-queue.php's
		// claim_due_items() for how the atomicity is guaranteed. Rows that
		// failed to decrypt (see that file's threat-model note — e.g. a
		// rotated wp_salt()) are already discarded before this loop sees them.
		foreach ( Odito_Queue::claim_due_items( 20 ) as $row ) {
			$payload = $row->decoded_payload;
			if ( ! is_array( $payload ) ) {
				Odito_Queue::mark_permanent_failure( $row->id );
				continue;
			}

			$result = Odito_Api::submit_form( $payload );

			if ( $result['success'] ) {
				Odito_Queue::mark_success( $row->id );
				continue;
			}

			if ( 401 === $result['status'] ) {
				Odito_Connection::record_heartbeat_result( $result );
				Odito_Queue::mark_permanent_failure( $row->id );
				continue;
			}

			if ( null !== $result['status'] && $result['status'] < 500 && 429 !== $result['status'] ) {
				Odito_Queue::mark_permanent_failure( $row->id );
				continue;
			}

			Odito_Queue::mark_retry_or_fail( $row );
		}

		Odito_Queue::cleanup_old_failed();
	}
}
