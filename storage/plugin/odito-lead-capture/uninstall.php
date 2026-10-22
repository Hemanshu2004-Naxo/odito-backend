<?php
/**
 * Uninstall handler.
 *
 * Runs only when the user explicitly deletes the plugin from the Plugins
 * screen (WordPress guarantees this file is never loaded any other way —
 * the WP_UNINSTALL_PLUGIN guard below is required by WordPress itself, not
 * optional defensive code).
 *
 * Removes ONLY the plugin's own local option. Does not:
 *   - delete anything on the Odito side (no remote call is made here at all)
 *   - delete WordPress content, forms, posts, or pages
 *   - delete any other plugin's data or unrelated options
 *
 * If the Odito user wants the connection/forms data removed from Odito
 * itself, that is done from the Odito dashboard (disconnect), not by
 * uninstalling this plugin — the two are intentionally independent.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'odito_connection' );
delete_option( 'odito_db_version' );

// Clear the scheduled cron events if deactivation was somehow skipped.
$sync_timestamp = wp_next_scheduled( 'odito_cron_sync' );
if ( $sync_timestamp ) {
	wp_unschedule_event( $sync_timestamp, 'odito_cron_sync' );
}
$queue_timestamp = wp_next_scheduled( 'odito_process_queue' );
if ( $queue_timestamp ) {
	wp_unschedule_event( $queue_timestamp, 'odito_process_queue' );
}

// The submission retry queue is Odito-specific temporary data (never
// customer WordPress content) — dropped on explicit uninstall along with
// the connection option. Never contains anything once a retry succeeds
// (Odito_Queue::mark_success deletes the row immediately), so this only
// ever removes still-pending or already-permanently-failed retry rows.
global $wpdb;
$table_name = $wpdb->prefix . 'odito_submission_queue';
// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name cannot be a bound parameter; no user input involved.
$wpdb->query( "DROP TABLE IF EXISTS {$table_name}" );
