<?php
/**
 * Odito_Admin
 *
 * The wp-admin settings page and its three form handlers (pair, disconnect,
 * sync-now) — every handler verifies capability + nonce first
 * (Odito_Security::verify_admin_action), sanitizes input, and never
 * displays the plugin secret after it's first stored.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Odito_Admin {

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'register_menu' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue_assets' ) );
		add_action( 'admin_post_odito_pair', array( __CLASS__, 'handle_pair' ) );
		add_action( 'admin_post_odito_disconnect', array( __CLASS__, 'handle_disconnect' ) );
		add_action( 'admin_post_odito_sync_now', array( __CLASS__, 'handle_sync_now' ) );
		add_action( 'admin_notices', array( __CLASS__, 'render_notices' ) );

		// A visit to the plugin's own settings page counts as one of the
		// "or when the WordPress admin loads the plugin settings page"
		// heartbeat triggers (Section 25) — cheap, and keeps "Last Seen"
		// fresh for anyone actively checking the connection.
		add_action( 'load-settings_page_odito-lead-capture', array( __CLASS__, 'heartbeat_on_page_load' ) );
	}

	public static function register_menu() {
		add_options_page(
			__( 'Odito Lead Capture', 'odito-lead-capture' ),
			__( 'Odito', 'odito-lead-capture' ),
			Odito_Security::REQUIRED_CAPABILITY,
			'odito-lead-capture',
			array( __CLASS__, 'render_settings_page' )
		);
	}

	public static function enqueue_assets( $hook ) {
		if ( 'settings_page_odito-lead-capture' !== $hook ) {
			return;
		}
		wp_enqueue_style( 'odito-admin', ODITO_PLUGIN_URL . 'admin/assets/css/admin.css', array(), ODITO_VERSION );
		wp_enqueue_script( 'odito-admin', ODITO_PLUGIN_URL . 'admin/assets/js/admin.js', array(), ODITO_VERSION, true );
	}

	public static function heartbeat_on_page_load() {
		if ( Odito_Connection::is_connected() ) {
			Odito_Connection::record_heartbeat_result( Odito_Api::heartbeat() );
		}
	}

	public static function render_settings_page() {
		if ( ! Odito_Security::current_user_can_manage() ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'odito-lead-capture' ) );
		}
		$state = Odito_Connection::get_status_for_display();
		// Local-only diagnostics (Section 33) — never sent to Odito, purely
		// for the site admin to see "is anything stuck retrying right now".
		$queue_counts = class_exists( 'Odito_Queue' ) ? Odito_Queue::get_status_counts() : array( 'pending' => 0, 'failed' => 0 );
		require ODITO_PLUGIN_DIR . 'admin/views/settings.php';
	}

	// ── Form handlers ─────────────────────────────────────────────────────

	public static function handle_pair() {
		Odito_Security::verify_admin_action( 'odito_pair_action', 'odito_pair_nonce' );

		$token = isset( $_POST['odito_pairing_token'] ) ? sanitize_text_field( wp_unslash( $_POST['odito_pairing_token'] ) ) : '';

		if ( empty( $token ) ) {
			self::redirect_with_notice( 'error', __( 'Please enter a pairing token.', 'odito-lead-capture' ) );
		}

		$result = Odito_Connection::pair( $token );

		if ( $result['success'] ) {
			self::redirect_with_notice( 'success', __( 'Successfully connected to Odito.', 'odito-lead-capture' ) );
		} else {
			self::redirect_with_notice( 'error', $result['message'] ? $result['message'] : __( 'Failed to connect to Odito.', 'odito-lead-capture' ) );
		}
	}

	public static function handle_disconnect() {
		Odito_Security::verify_admin_action( 'odito_disconnect_action', 'odito_disconnect_nonce' );

		Odito_Connection::disconnect();

		self::redirect_with_notice( 'success', __( 'Disconnected from Odito. Your WordPress site and forms were not modified.', 'odito-lead-capture' ) );
	}

	public static function handle_sync_now() {
		Odito_Security::verify_admin_action( 'odito_sync_action', 'odito_sync_nonce' );

		if ( ! Odito_Connection::is_connected() ) {
			self::redirect_with_notice( 'error', __( 'Connect to Odito before syncing forms.', 'odito-lead-capture' ) );
		}

		$forms = Odito_Forms::detect_forms();
		$result = Odito_Api::sync_forms( $forms );
		Odito_Connection::record_sync_result( $result, count( $forms ) );

		if ( $result['success'] ) {
			self::redirect_with_notice(
				'success',
				sprintf(
					/* translators: %d: number of forms detected */
					_n( '%d form synced with Odito.', '%d forms synced with Odito.', count( $forms ), 'odito-lead-capture' ),
					count( $forms )
				)
			);
		} else {
			self::redirect_with_notice( 'error', $result['message'] ? $result['message'] : __( 'Failed to sync forms.', 'odito-lead-capture' ) );
		}
	}

	private static function redirect_with_notice( $type, $message ) {
		set_transient( 'odito_admin_notice', array( 'type' => $type, 'message' => $message ), 30 );
		wp_safe_redirect( admin_url( 'options-general.php?page=odito-lead-capture' ) );
		exit;
	}

	public static function render_notices() {
		$screen = get_current_screen();
		if ( ! $screen || 'settings_page_odito-lead-capture' !== $screen->id ) {
			return;
		}
		$notice = get_transient( 'odito_admin_notice' );
		if ( ! $notice ) {
			return;
		}
		delete_transient( 'odito_admin_notice' );

		$css_class = 'error' === $notice['type'] ? 'notice-error' : 'notice-success';
		printf(
			'<div class="notice %1$s is-dismissible"><p>%2$s</p></div>',
			esc_attr( $css_class ),
			esc_html( $notice['message'] )
		);
	}
}
