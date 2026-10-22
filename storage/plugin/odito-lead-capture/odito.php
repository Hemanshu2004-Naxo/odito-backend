<?php
/**
 * Plugin Name:       Odito Lead Capture
 * Plugin URI:        https://oditoai.com
 * Description:       Secure integration between WordPress websites and Odito. Connects your site to your Odito project, detects your forms (Contact Form 7, Divi, generic HTML), and turns real Contact Form 7 submissions into Odito leads. Sensitive fields (passwords, payment details, security tokens) are always excluded. Divi and generic form submission capture are not yet supported — see readme.txt.
 * Version:           1.2.0
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * Author:            Odito
 * Author URI:        https://oditoai.com
 * License:           GPL v2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       odito-lead-capture
 * Domain Path:       /languages
 *
 * Every function, class, hook, and option name in this plugin is prefixed
 * `odito_`/`Odito_` to avoid collisions in the global WordPress namespace —
 * see includes/ for the class-per-responsibility breakdown.
 */

// Block direct access.
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ODITO_VERSION', '1.2.0' );
// Bumped independently of ODITO_VERSION only when the queue table's schema
// itself changes (Phase 3C added claimed_token/processing_until) — lets
// odito_maybe_upgrade() below re-run dbDelta() on existing installs
// without needing every plugin version bump to imply a schema change.
define( 'ODITO_DB_VERSION', '2' );
define( 'ODITO_MIN_WP_VERSION', '5.6' );
define( 'ODITO_PLUGIN_FILE', __FILE__ );
define( 'ODITO_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'ODITO_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

// Overridable in wp-config.php for local/staging testing against a
// non-production Odito backend — never hardcoded elsewhere in the plugin.
if ( ! defined( 'ODITO_API_BASE_URL' ) ) {
	define( 'ODITO_API_BASE_URL', 'https://api.oditoai.com/api' );
}

/**
 * Fails gracefully on an unsupported WordPress version instead of a fatal
 * error — the file itself must stay parseable by old PHP too, so no
 * language features newer than this function are used above this check.
 */
function odito_is_wp_version_supported() {
	global $wp_version;
	return version_compare( $wp_version, ODITO_MIN_WP_VERSION, '>=' );
}

/**
 * Activation: local options only, no destructive or external action. If
 * the WordPress version is unsupported, deactivates itself and surfaces an
 * admin notice rather than fatal-erroring mid-activation.
 */
function odito_activate() {
	if ( ! odito_is_wp_version_supported() ) {
		deactivate_plugins( plugin_basename( ODITO_PLUGIN_FILE ) );
		set_transient( 'odito_activation_error', 'unsupported_wp_version', 60 );
		return;
	}

	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-connection.php';
	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-queue.php';
	Odito_Connection::maybe_create_default_options();
	Odito_Queue::create_table();

	if ( ! wp_next_scheduled( 'odito_cron_sync' ) ) {
		wp_schedule_event( time(), 'hourly', 'odito_cron_sync' );
	}
	if ( ! wp_next_scheduled( 'odito_process_queue' ) ) {
		wp_schedule_event( time(), 'odito_five_minutes', 'odito_process_queue' );
	}
}
register_activation_hook( ODITO_PLUGIN_FILE, 'odito_activate' );

/**
 * WordPress core only ships hourly/twicedaily/daily cron intervals — queue
 * retries need finer granularity for the bounded-backoff schedule
 * (1min/5min/15min/1hr) in class-odito-queue.php to mean anything, so a
 * 5-minute interval is registered via the standard `cron_schedules` filter.
 */
function odito_add_cron_schedules( $schedules ) {
	$schedules['odito_five_minutes'] = array(
		'interval' => 5 * MINUTE_IN_SECONDS,
		'display'  => __( 'Every 5 Minutes (Odito)', 'odito-lead-capture' ),
	);
	return $schedules;
}
add_filter( 'cron_schedules', 'odito_add_cron_schedules' ); // phpcs:ignore WordPress.WP.CronInterval.CronSchedulesInterval

/**
 * Schema migration path for existing installs (Phase 3C — the queue table
 * gained claimed_token/processing_until columns). dbDelta() is safe to call
 * repeatedly (it diffs against the live schema and only applies what's
 * missing), but there's no reason to run it on every single page load —
 * gated behind a stored option so it only actually executes right after an
 * upgrade. Hooked on `plugins_loaded` rather than activation, since
 * upgrading via the Plugins screen does NOT re-fire register_activation_hook.
 */
function odito_maybe_upgrade() {
	if ( get_option( 'odito_db_version' ) === ODITO_DB_VERSION ) {
		return;
	}
	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-queue.php';
	Odito_Queue::create_table();
	update_option( 'odito_db_version', ODITO_DB_VERSION, false );
}
add_action( 'plugins_loaded', 'odito_maybe_upgrade' );

/**
 * Deactivation: stop the recurring sync/queue processing, but keep the
 * stored connection and any queued-but-not-yet-failed retries — re-activating
 * should not require re-pairing. Never deletes data; that is uninstall.php's
 * job, and only when the user explicitly uninstalls.
 */
function odito_deactivate() {
	$sync_timestamp = wp_next_scheduled( 'odito_cron_sync' );
	if ( $sync_timestamp ) {
		wp_unschedule_event( $sync_timestamp, 'odito_cron_sync' );
	}
	$queue_timestamp = wp_next_scheduled( 'odito_process_queue' );
	if ( $queue_timestamp ) {
		wp_unschedule_event( $queue_timestamp, 'odito_process_queue' );
	}
}
register_deactivation_hook( ODITO_PLUGIN_FILE, 'odito_deactivate' );

/**
 * Surfaces the graceful-failure activation error (unsupported WP version)
 * as a normal admin notice, one time.
 */
function odito_maybe_show_activation_notice() {
	$error = get_transient( 'odito_activation_error' );
	if ( ! $error ) {
		return;
	}
	delete_transient( 'odito_activation_error' );

	if ( 'unsupported_wp_version' === $error ) {
		printf(
			'<div class="notice notice-error"><p>%s</p></div>',
			esc_html(
				sprintf(
					/* translators: %s: minimum required WordPress version */
					__( 'Odito Lead Capture requires WordPress %s or newer and has been deactivated. Please update WordPress and reactivate the plugin.', 'odito-lead-capture' ),
					ODITO_MIN_WP_VERSION
				)
			)
		);
	}
}
add_action( 'admin_notices', 'odito_maybe_show_activation_notice' );

/**
 * Loads the plugin once WordPress core (and other plugins, e.g. Contact
 * Form 7) have finished loading — class-odito-forms.php's CF7 detection
 * needs WPCF7_ContactForm to already exist, which it won't during earlier
 * hooks like `plugins_loaded` on some load orders, so `init` is used here
 * instead.
 */
function odito_init() {
	if ( ! odito_is_wp_version_supported() ) {
		return;
	}

	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-security.php';
	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-api.php';
	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-connection.php';
	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-forms.php';
	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-queue.php';
	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-submission-dispatcher.php';
	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-cf7-capture.php';
	require_once ODITO_PLUGIN_DIR . 'includes/class-odito-divi-capture.php';

	if ( is_admin() ) {
		require_once ODITO_PLUGIN_DIR . 'includes/class-odito-admin.php';
		Odito_Admin::init();
	}

	Odito_Cf7_Capture::init();

	// Divi's contact form (confirmed against a real production capture) is
	// a direct same-page POST, not an AJAX action — there is no discrete
	// "submission" hook to attach to. Odito_Divi_Capture::init() runs its
	// check synchronously, right here, rather than registering a callback
	// for a later event, so it executes as early in this same `init` pass
	// as odito_init() itself does (see the priority-1 registration below)
	// — guaranteed to run before Divi's own redirect-on-success logic,
	// which cannot fire before `init` completes (WordPress's lifecycle is
	// strictly ordered: init -> wp -> template_redirect -> theme output).
	// A safe no-op on any request that isn't a genuine Divi submission,
	// and on any site not running Divi at all.
	Odito_Divi_Capture::init();

	add_action( 'odito_cron_sync', array( 'Odito_Connection', 'run_scheduled_sync' ) );
	add_action( 'odito_process_queue', array( 'Odito_Cf7_Capture', 'process_queue' ) );
}
// Priority 1 (not the default 10): Odito_Divi_Capture's check runs inline
// as part of this same call, and must run as early in `init` as possible
// so nothing Divi does later in the request lifecycle (including on
// `init` itself, at a later priority) can have already redirected/exited
// before we've had a chance to observe the submission.
add_action( 'init', 'odito_init', 1 );
