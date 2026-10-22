<?php
/**
 * Odito_Connection
 *
 * Owns the plugin's local WordPress-side state: the pairing flow, and the
 * `odito_connection` option where the plugin credential lives. This is a
 * SEPARATE, plugin-scoped credential — never the Odito user's password,
 * never an Odito JWT, and never the WordPress Application Password Odito's
 * own dashboard connection (Phase 2) uses. See class-odito-api.php for how
 * it's presented on outbound requests.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Odito_Connection {

	const OPTION_NAME = 'odito_connection';

	public static function maybe_create_default_options() {
		if ( false === get_option( self::OPTION_NAME, false ) ) {
			add_option( self::OPTION_NAME, self::empty_state(), '', 'no' );
		}
	}

	private static function empty_state() {
		return array(
			'status'                => 'not_connected',
			'plugin_id'             => '',
			'secret'                => '',
			'project_id'            => '',
			'project_name'          => '',
			'site_url'              => '',
			'connected_at'          => '',
			'last_heartbeat_at'     => '',
			'last_sync_at'          => '',
			'last_sync_forms_count' => 0,
			'last_error'            => '',
		);
	}

	private static function get_state() {
		$state = get_option( self::OPTION_NAME, self::empty_state() );
		return is_array( $state ) ? wp_parse_args( $state, self::empty_state() ) : self::empty_state();
	}

	public static function is_connected() {
		$state = self::get_state();
		return 'connected' === $state['status'] && ! empty( $state['plugin_id'] ) && ! empty( $state['secret'] );
	}

	public static function get_status_for_display() {
		$state = self::get_state();
		unset( $state['secret'] ); // never exposed to the admin UI after initial creation, per Section 8
		return $state;
	}

	/** Only what class-odito-api.php needs to authenticate a request. */
	public static function get_credentials() {
		$state = self::get_state();
		if ( empty( $state['plugin_id'] ) || empty( $state['secret'] ) ) {
			return null;
		}
		return array(
			'plugin_id' => $state['plugin_id'],
			'secret'    => $state['secret'],
		);
	}

	/**
	 * Consumes a pairing token pasted into the settings page. On success,
	 * stores the returned plugin credential locally — this is the ONLY
	 * place the secret is ever written, and it is never re-displayed after
	 * this call returns.
	 */
	public static function pair( $pairing_token ) {
		$site_url = home_url();
		global $wp_version;

		$result = Odito_Api::pair( $pairing_token, $site_url, $wp_version, ODITO_VERSION );

		if ( ! $result['success'] ) {
			self::update_state( array( 'last_error' => $result['message'] ) );
			return array( 'success' => false, 'message' => $result['message'] );
		}

		$data = isset( $result['data']['data'] ) ? $result['data']['data'] : array();

		self::update_state(
			array(
				'status'       => 'connected',
				'plugin_id'    => isset( $data['pluginId'] ) ? $data['pluginId'] : '',
				'secret'       => isset( $data['secret'] ) ? $data['secret'] : '',
				'project_id'   => isset( $data['projectId'] ) ? $data['projectId'] : '',
				'project_name' => isset( $data['projectName'] ) ? $data['projectName'] : '',
				'site_url'     => $site_url,
				'connected_at' => current_time( 'mysql' ),
				'last_error'   => '',
			)
		);

		return array( 'success' => true );
	}

	/**
	 * Local-only disconnect (Section 5/27): clears the stored credential so
	 * the plugin stops sending data. Does not delete anything on the Odito
	 * side or in WordPress itself — if the Odito user separately disconnects
	 * the WordPress connection from the dashboard, this same local state is
	 * what a future heartbeat/sync 401 (revoked credential) would surface
	 * as a connection error here too.
	 */
	public static function disconnect() {
		update_option( self::OPTION_NAME, self::empty_state(), 'no' );
	}

	private static function update_state( $partial ) {
		$state = array_merge( self::get_state(), $partial );
		update_option( self::OPTION_NAME, $state, 'no' );
	}

	public static function record_heartbeat_result( $result ) {
		if ( $result['success'] ) {
			self::update_state(
				array(
					'last_heartbeat_at' => current_time( 'mysql' ),
					'last_error'        => '',
				)
			);
		} else {
			self::handle_request_failure( $result );
		}
	}

	public static function record_sync_result( $result, $forms_count ) {
		if ( $result['success'] ) {
			self::update_state(
				array(
					'last_sync_at'          => current_time( 'mysql' ),
					'last_sync_forms_count' => $forms_count,
					'last_error'            => '',
				)
			);
		} else {
			self::handle_request_failure( $result );
		}
	}

	/**
	 * A 401 from Odito means the credential is invalid or was revoked
	 * (e.g. the Odito user disconnected WordPress from the dashboard,
	 * Section 27) — the plugin must stop presenting itself as connected
	 * rather than silently keep retrying with a dead credential.
	 */
	private static function handle_request_failure( $result ) {
		if ( 401 === $result['status'] ) {
			self::update_state(
				array(
					'status'     => 'not_connected',
					'last_error' => __( 'Odito connection was revoked. Please reconnect.', 'odito-lead-capture' ),
				)
			);
			return;
		}
		self::update_state( array( 'last_error' => $result['message'] ) );
	}

	/**
	 * WP-Cron callback (registered in odito.php) — periodic heartbeat +
	 * form sync, the automatic counterpart to the admin page's manual
	 * "Sync Now" button (class-odito-admin.php).
	 */
	public static function run_scheduled_sync() {
		if ( ! self::is_connected() ) {
			return;
		}

		$heartbeat_result = Odito_Api::heartbeat();
		self::record_heartbeat_result( $heartbeat_result );

		if ( ! self::is_connected() ) {
			// Heartbeat itself found the credential revoked — skip the sync call.
			return;
		}

		$forms = Odito_Forms::detect_forms();
		$sync_result = Odito_Api::sync_forms( $forms );
		self::record_sync_result( $sync_result, count( $forms ) );
	}
}
