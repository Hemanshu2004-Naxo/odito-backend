<?php
/**
 * Odito_Submission_Dispatcher
 *
 * The one place that decides what happens after a first synchronous
 * delivery attempt for ANY captured submission (Contact Form 7, Divi, or
 * any future provider) — success, permanent rejection (400/401, don't
 * queue), or temporary failure (network error/429/5xx, queue for
 * background retry via the existing WP-Cron queue processor).
 *
 * Extracted out of Odito_Cf7_Capture::send_with_fallback() (pure
 * extraction — identical logic, identical behavior for CF7) so a second
 * capture source doesn't need to re-implement or diverge from the same
 * retry-classification rules. class-odito-queue.php's process_queue()
 * loop is provider-agnostic already (it only sees an opaque payload), so
 * nothing about queue draining needs to change for a new capture source —
 * only the *first* synchronous attempt needed this shared home.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Odito_Submission_Dispatcher {

	/**
	 * Exactly one synchronous attempt (never retried synchronously inside
	 * the visitor's own request) with a short timeout. Only genuinely
	 * temporary failures are queued — a 400 (form not synced/not active) or
	 * 401 (revoked credential) would fail identically on every retry, so
	 * queuing those would just churn the retry table for nothing.
	 */
	public static function dispatch( $payload ) {
		$result = Odito_Api::submit_form( $payload );

		if ( $result['success'] ) {
			return $result;
		}

		if ( 401 === $result['status'] ) {
			Odito_Connection::record_heartbeat_result( $result ); // reuses the existing "credential revoked -> flip to not_connected" handling
			return $result;
		}

		if ( null !== $result['status'] && $result['status'] < 500 && 429 !== $result['status'] ) {
			// Permanent client-side rejection (400 etc., e.g. FORM_NOT_REGISTERED /
			// FORM_NOT_ACTIVE) — do not queue.
			return $result;
		}

		// Temporary failure (network error, timeout, 429, 5xx) — queue for
		// background retry rather than blocking or retrying inline.
		Odito_Queue::enqueue( $payload['eventId'], $payload );
		return $result;
	}
}
