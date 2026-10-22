<?php
/**
 * Settings page template. Rendered by Odito_Admin::render_settings_page()
 * with $state (Odito_Connection::get_status_for_display() — the secret is
 * already stripped before this file ever sees the array) and
 * $queue_counts (Odito_Queue::get_status_counts() — local-only, never sent
 * to Odito).
 *
 * @var array $state
 * @var array $queue_counts
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$is_connected = isset( $state['status'] ) && 'connected' === $state['status'];
?>
<div class="wrap odito-settings">
	<h1><?php esc_html_e( 'Odito Lead Capture', 'odito-lead-capture' ); ?></h1>

	<div class="odito-card">
		<h2><?php esc_html_e( 'Connection', 'odito-lead-capture' ); ?></h2>

		<?php if ( $is_connected ) : ?>
			<table class="widefat odito-status-table" role="presentation">
				<tbody>
					<tr>
						<th scope="row"><?php esc_html_e( 'Status', 'odito-lead-capture' ); ?></th>
						<td><span class="odito-badge odito-badge-success"><?php esc_html_e( 'Connected', 'odito-lead-capture' ); ?></span></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Website', 'odito-lead-capture' ); ?></th>
						<td><?php echo esc_html( isset( $state['site_url'] ) ? $state['site_url'] : '' ); ?></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Odito Project', 'odito-lead-capture' ); ?></th>
						<td><?php echo esc_html( ! empty( $state['project_name'] ) ? $state['project_name'] : __( '(unnamed project)', 'odito-lead-capture' ) ); ?></td>
					</tr>
				</tbody>
			</table>

			<h2><?php esc_html_e( 'Last Sync', 'odito-lead-capture' ); ?></h2>
			<table class="widefat odito-status-table" role="presentation">
				<tbody>
					<tr>
						<th scope="row"><?php esc_html_e( 'Forms Detected', 'odito-lead-capture' ); ?></th>
						<td><?php echo esc_html( isset( $state['last_sync_forms_count'] ) ? $state['last_sync_forms_count'] : 0 ); ?></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Last Sync', 'odito-lead-capture' ); ?></th>
						<td><?php echo esc_html( ! empty( $state['last_sync_at'] ) ? $state['last_sync_at'] : __( 'Never', 'odito-lead-capture' ) ); ?></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Last Seen by Odito', 'odito-lead-capture' ); ?></th>
						<td><?php echo esc_html( ! empty( $state['last_heartbeat_at'] ) ? $state['last_heartbeat_at'] : __( 'Never', 'odito-lead-capture' ) ); ?></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Pending Submissions', 'odito-lead-capture' ); ?></th>
						<td><?php echo esc_html( isset( $queue_counts['pending'] ) ? $queue_counts['pending'] : 0 ); ?></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Failed Submissions', 'odito-lead-capture' ); ?></th>
						<td><?php echo esc_html( isset( $queue_counts['failed'] ) ? $queue_counts['failed'] : 0 ); ?></td>
					</tr>
				</tbody>
			</table>

			<?php if ( ! empty( $state['last_error'] ) ) : ?>
				<p class="odito-error-text"><?php echo esc_html( $state['last_error'] ); ?></p>
			<?php endif; ?>

			<p class="odito-actions">
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
					<input type="hidden" name="action" value="odito_sync_now" />
					<?php wp_nonce_field( 'odito_sync_action', 'odito_sync_nonce' ); ?>
					<button type="submit" class="button button-primary"><?php esc_html_e( 'Sync Now', 'odito-lead-capture' ); ?></button>
				</form>

				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;" class="odito-disconnect-form">
					<input type="hidden" name="action" value="odito_disconnect" />
					<?php wp_nonce_field( 'odito_disconnect_action', 'odito_disconnect_nonce' ); ?>
					<button type="submit" class="button odito-disconnect-button" data-confirm="<?php echo esc_attr__( 'Disconnect this site from Odito? Your WordPress content and forms will not be changed.', 'odito-lead-capture' ); ?>"><?php esc_html_e( 'Disconnect', 'odito-lead-capture' ); ?></button>
				</form>
			</p>

			<p class="description">
				<?php esc_html_e( 'Odito detects your form structure automatically. For Contact Form 7, a real submission also becomes a lead in Odito — fields that look like passwords, payment details, or security tokens are always excluded before anything is sent.', 'odito-lead-capture' ); ?>
			</p>

		<?php else : ?>
			<p><?php esc_html_e( 'This site is not connected to Odito yet.', 'odito-lead-capture' ); ?></p>

			<?php if ( ! empty( $state['last_error'] ) ) : ?>
				<p class="odito-error-text"><?php echo esc_html( $state['last_error'] ); ?></p>
			<?php endif; ?>

			<ol class="odito-pairing-steps">
				<li><?php esc_html_e( 'In your Odito dashboard, open this project\'s Settings and click "Connect WordPress" to generate a pairing token.', 'odito-lead-capture' ); ?></li>
				<li><?php esc_html_e( 'Paste that token below and click Connect. The token is one-time use and expires after 15 minutes.', 'odito-lead-capture' ); ?></li>
			</ol>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="odito_pair" />
				<?php wp_nonce_field( 'odito_pair_action', 'odito_pair_nonce' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="odito_pairing_token"><?php esc_html_e( 'Pairing Token', 'odito-lead-capture' ); ?></label></th>
						<td><input type="text" id="odito_pairing_token" name="odito_pairing_token" class="regular-text" autocomplete="off" required /></td>
					</tr>
				</table>
				<button type="submit" class="button button-primary"><?php esc_html_e( 'Connect', 'odito-lead-capture' ); ?></button>
			</form>
		<?php endif; ?>
	</div>
</div>
