<?php
/**
 * Odito_Security
 *
 * Centralizes the capability check, nonce verification, and sensitive-field
 * filtering used everywhere else in the plugin, so every admin action goes
 * through the same gate rather than re-implementing the checks inline.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Odito_Security {

	/**
	 * The WordPress capability required for every Odito admin action.
	 * Deliberately a real capability check (Section 13 of the spec), never
	 * a username/role-name comparison.
	 */
	const REQUIRED_CAPABILITY = 'manage_options';

	public static function current_user_can_manage() {
		return current_user_can( self::REQUIRED_CAPABILITY );
	}

	/**
	 * Verifies capability + nonce together and dies with a safe message on
	 * failure — every admin-post handler in class-odito-admin.php calls
	 * this first, before touching any input.
	 */
	public static function verify_admin_action( $nonce_action, $nonce_field ) {
		if ( ! self::current_user_can_manage() ) {
			wp_die( esc_html__( 'You do not have permission to perform this action.', 'odito-lead-capture' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $nonce_action, $nonce_field );
	}

	/**
	 * Field names that must never be synchronized to Odito, even though
	 * only structure (name/type) is sent, never a submitted value.
	 * Intentionally mirrored (not shared) in the Node backend's
	 * wordPressFormService.js SENSITIVE_FIELD_PATTERNS — see that file's
	 * comment for why this is duplicated rather than fetched at runtime.
	 *
	 * Boundary-aware wrapper used for short keywords instead of \b — PCRE's
	 * \b treats `_` as a word character, so `/\btoken\b/` does NOT match
	 * "csrf_token" (no boundary between `_` and `t`). Caught during Phase
	 * 3A testing via the Node-side regex port (PCRE and JS regex agree on
	 * this behavior) — see scratch test log in the Phase 3A report.
	 * Longer/lower-collision keywords (password, secret, token) use plain
	 * substring matching instead, deliberately broad: over-filtering a
	 * legitimate field name is a safe failure, under-filtering a sensitive
	 * one is not.
	 */
	private static $sensitive_patterns = array(
		'/(?:^|[^a-z0-9])pwd(?:$|[^a-z0-9])/i',
		'/(?:^|[^a-z0-9])ssn(?:$|[^a-z0-9])/i',
		'/(?:^|[^a-z0-9])cvv2?(?:$|[^a-z0-9])/i',
		'/(?:^|[^a-z0-9])cvc(?:$|[^a-z0-9])/i',
		'/password/i',
		'/passwd/i',
		'/secret/i',
		'/token/i',
		'/credit[\s_-]?card/i',
		'/card[\s_-]?number/i',
		'/social[\s_-]?security/i',
		'/security[\s_-]?code/i',
	);

	public static function is_sensitive_field( $field_name ) {
		if ( empty( $field_name ) ) {
			return false;
		}
		foreach ( self::$sensitive_patterns as $pattern ) {
			if ( preg_match( $pattern, $field_name ) ) {
				return true;
			}
		}
		return false;
	}
}
