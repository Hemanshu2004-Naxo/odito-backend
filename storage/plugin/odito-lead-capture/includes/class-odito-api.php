<?php
/**
 * Odito_Api
 *
 * Thin HTTP client for every WordPress -> Odito call. Uses WordPress's own
 * wp_remote_post()/wp_remote_get() (never curl/file_get_contents directly)
 * so proxy settings, SSL verification, and filters the site's hosting
 * environment already relies on all keep working correctly.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Odito_Api {

	const TIMEOUT_SECONDS = 15;
	// Deliberately much shorter than TIMEOUT_SECONDS — this is the ONE
	// synchronous attempt made inside the customer's actual form-submit
	// request (see class-odito-cf7-capture.php); Section 17 requires the
	// customer's form to never wait long on Odito. Anything that doesn't
	// finish within this window is treated as a failure and handed to
	// Odito_Queue for a background retry, not retried synchronously here.
	const SUBMISSION_TIMEOUT_SECONDS = 4;

	/**
	 * Low-level request helper. Returns a normalized array —
	 * ['success' => bool, 'status' => int|null, 'data' => array|null, 'message' => string|null]
	 * — never throws, never leaks raw WP_Error/HTTP internals to callers.
	 */
	private static function request( $method, $endpoint, $body = array(), $headers = array(), $timeout = null ) {
		$url = rtrim( ODITO_API_BASE_URL, '/' ) . $endpoint;

		$args = array(
			'method'  => $method,
			'timeout' => null === $timeout ? self::TIMEOUT_SECONDS : $timeout,
			'headers' => array_merge(
				array( 'Content-Type' => 'application/json' ),
				$headers
			),
		);

		if ( ! empty( $body ) ) {
			$args['body'] = wp_json_encode( $body );
		}

		$response = wp_remote_request( $url, $args );

		if ( is_wp_error( $response ) ) {
			// Network-level failure (DNS, timeout, TLS) — never includes
			// credentials, since none of the values above are secret except
			// the header value itself, which WP_Error never echoes back.
			return array(
				'success' => false,
				'status'  => null,
				'data'    => null,
				'message' => $response->get_error_message(),
			);
		}

		$status = wp_remote_retrieve_response_code( $response );
		$raw    = wp_remote_retrieve_body( $response );
		$data   = json_decode( $raw, true );

		if ( $status < 200 || $status >= 300 ) {
			return array(
				'success' => false,
				'status'  => $status,
				'data'    => $data,
				'message' => is_array( $data ) && isset( $data['message'] ) ? $data['message'] : __( 'Odito request failed.', 'odito-lead-capture' ),
			);
		}

		return array(
			'success' => true,
			'status'  => $status,
			'data'    => is_array( $data ) ? $data : null,
			'message' => null,
		);
	}

	/** Auth headers for every plugin-credential-authenticated call. */
	private static function plugin_auth_headers() {
		$credentials = Odito_Connection::get_credentials();
		if ( ! $credentials ) {
			return array();
		}
		return array(
			'X-Odito-Plugin-Id'     => $credentials['plugin_id'],
			'X-Odito-Plugin-Secret' => $credentials['secret'],
		);
	}

	/**
	 * Consumes a pairing token pasted into the settings page. No plugin
	 * credential exists yet at this point — the token itself is the proof
	 * of identity for this one call.
	 */
	public static function pair( $pairing_token, $site_url, $wp_version, $plugin_version ) {
		return self::request(
			'POST',
			'/wordpress/plugin/pair',
			array(
				'token'           => $pairing_token,
				'siteUrl'         => $site_url,
				'wordpressVersion' => $wp_version,
				'pluginVersion'   => $plugin_version,
			)
		);
	}

	public static function heartbeat() {
		global $wp_version;
		return self::request(
			'POST',
			'/wordpress/plugin/heartbeat',
			array(
				'wordpressVersion' => $wp_version,
				'pluginVersion'   => ODITO_VERSION,
			),
			self::plugin_auth_headers()
		);
	}

	/** $forms is already-normalized, already-filtered structure-only data (see class-odito-forms.php). */
	public static function sync_forms( $forms ) {
		return self::request(
			'POST',
			'/wordpress/plugin/forms/sync',
			array( 'forms' => $forms ),
			self::plugin_auth_headers()
		);
	}

	/**
	 * $payload is the exact {eventId, form, submission, context} shape the
	 * backend expects (see wordPressSubmissionValidator.js) — already
	 * built and already filtered of sensitive fields by the caller
	 * (class-odito-cf7-capture.php) before this is ever invoked. Uses the
	 * short SUBMISSION_TIMEOUT_SECONDS, not the default, per Section 17.
	 */
	public static function submit_form( $payload ) {
		return self::request(
			'POST',
			'/wordpress/plugin/submissions',
			$payload,
			self::plugin_auth_headers(),
			self::SUBMISSION_TIMEOUT_SECONDS
		);
	}
}
