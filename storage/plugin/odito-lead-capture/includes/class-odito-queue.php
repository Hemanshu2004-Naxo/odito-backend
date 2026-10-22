<?php
/**
 * Odito_Queue
 *
 * A dedicated custom table for retrying failed submission deliveries — not
 * a single serialized WordPress option, which would grow unbounded and
 * require read-modify-write of the entire blob for every enqueue/dequeue
 * (a race hazard under any real concurrency, e.g. two form submissions at
 * once). A custom table gives row-level operations, proper indexing on
 * (status, next_attempt_at), and bounded growth via cleanup_old_failed().
 *
 * Action Scheduler was considered (Section 18 asks for a tradeoff
 * explanation) but not used: it's bundled by WooCommerce/some other
 * plugins, not WordPress core, so it cannot be relied on being present on
 * an arbitrary site — depending on it would make the plugin's retry
 * reliability conditional on what ELSE happens to be installed, which is
 * fragile. A plain wpdb table + WP-Cron has no such dependency.
 *
 * Phase 3C additions:
 *   - Atomic claim (claim_due_items) so two overlapping WP-Cron runs (a
 *     real possibility — WP-Cron has no built-in mutex) can never process
 *     the same row concurrently.
 *   - The payload column is encrypted at rest (AES-256-GCM, key derived
 *     from wp_salt()) — see encrypt_payload()/decrypt_payload() below for
 *     the threat model this does and doesn't cover.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Odito_Queue {

	const MAX_ATTEMPTS = 5; // attempt 1 = the immediate synchronous try (never queued); 2-5 are queued retries below.
	const RETENTION_DAYS_FAILED = 7;
	// A claim outlives one cron tick (5 min, see odito.php's 'odito_five_minutes'
	// schedule) so a normally-finishing run never has its own claim expire out
	// from under it, but is short enough that a genuinely crashed/killed PHP
	// process's claimed rows become reclaimable well within the same hour
	// rather than being stuck until MAX_ATTEMPTS review.
	const CLAIM_LEASE_SECONDS = 4 * MINUTE_IN_SECONDS;

	private static function table_name() {
		global $wpdb;
		return $wpdb->prefix . 'odito_submission_queue';
	}

	public static function create_table() {
		global $wpdb;
		$table_name = self::table_name();
		$charset_collate = $wpdb->get_charset_collate();

		// dbDelta requires this exact formatting (two spaces after PRIMARY KEY,
		// KEY on its own line, etc.) — see https://developer.wordpress.org/reference/functions/dbdelta/
		// dbDelta() diffs this against the live schema and ALTERs in place, so
		// calling create_table() again on an upgrade (see odito_maybe_upgrade()
		// in odito.php) safely adds the Phase 3C columns to an existing
		// Phase 3B install without losing queued rows.
		$sql = "CREATE TABLE {$table_name} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			event_id VARCHAR(200) NOT NULL,
			payload LONGTEXT NOT NULL,
			attempts SMALLINT UNSIGNED NOT NULL DEFAULT 1,
			status VARCHAR(20) NOT NULL DEFAULT 'pending',
			claimed_token VARCHAR(64) DEFAULT NULL,
			processing_until DATETIME DEFAULT NULL,
			next_attempt_at DATETIME NOT NULL,
			created_at DATETIME NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY event_id (event_id),
			KEY status_next_attempt (status, next_attempt_at)
		) {$charset_collate};";

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		dbDelta( $sql );
	}

	// ── Payload encryption at rest ──────────────────────────────────────
	//
	// Threat model: this protects queued (not-yet-delivered) submission
	// data from casual disclosure via direct database access/backup/dump —
	// e.g. a shared-hosting neighbor, a leaked DB backup, or a read-only
	// SQL injection elsewhere on the site. It does NOT protect against an
	// attacker with PHP code-execution on the same site (they can compute
	// wp_salt() themselves) — no application-level encryption scheme can
	// defend against that, since the key must be derivable by the same
	// runtime that needs to decrypt it. This is the same boundary every
	// WordPress plugin that encrypts stored secrets operates within.
	//
	// Key: SHA-256 of wp_salt('auth') + a fixed context string, giving 32
	// raw bytes for AES-256. wp_salt() is WordPress's own standard
	// per-installation secret (AUTH_KEY in wp-config.php, or an
	// auto-generated option if undefined) — not a bespoke secret this
	// plugin invents or stores itself. Never written to the queue table.
	//
	// Rotation: if a site admin rotates their WordPress secret keys (rare,
	// admin-initiated), any THEN-QUEUED rows become undecryptable on the
	// next attempt. Since rows are short-lived (delivered or permanently
	// failed within roughly an hour under the backoff schedule) and this
	// plugin already treats "can't process this row" as a permanent
	// failure to be discarded (never a crash), the practical impact of a
	// key rotation is losing a handful of in-flight retries, not silent
	// corruption or a fatal error.
	private static function get_encryption_key() {
		return hash( 'sha256', wp_salt( 'auth' ) . '|odito_queue_payload_v1', true );
	}

	private static function encrypt_payload( $plaintext_json ) {
		if ( ! function_exists( 'openssl_encrypt' ) ) {
			return null; // caller must treat this as "cannot queue safely" rather than falling back to plaintext.
		}
		$key = self::get_encryption_key();
		$iv = random_bytes( 12 ); // GCM nonce — random per record, never reused with the same key.
		$tag = '';
		$ciphertext = openssl_encrypt( $plaintext_json, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag );
		if ( false === $ciphertext || '' === $tag ) {
			return null;
		}
		return base64_encode( $iv . $tag . $ciphertext );
	}

	/** Returns null on any decryption failure (wrong/rotated key, corrupt data) — never a fatal error, never partial/garbage plaintext. */
	private static function decrypt_payload( $encoded ) {
		$raw = base64_decode( $encoded, true );
		if ( false === $raw || strlen( $raw ) < 29 ) { // 12-byte IV + 16-byte GCM tag + at least 1 byte of ciphertext
			return null;
		}
		$iv = substr( $raw, 0, 12 );
		$tag = substr( $raw, 12, 16 );
		$ciphertext = substr( $raw, 28 );
		$key = self::get_encryption_key();
		$plaintext = openssl_decrypt( $ciphertext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag );
		return false === $plaintext ? null : $plaintext;
	}

	/**
	 * Queues a submission for retry after its first (synchronous) attempt
	 * failed. $payload is the exact JSON-ready array that was already sent
	 * once — never regenerated on retry, so the eventId (and therefore
	 * Odito's idempotency guarantee) stays stable across every attempt.
	 * Returns false (and enqueues nothing) if the payload could not be
	 * encrypted — a submission that can't be safely queued is dropped, not
	 * stored insecurely as a fallback.
	 */
	public static function enqueue( $event_id, $payload ) {
		global $wpdb;

		$encrypted = self::encrypt_payload( wp_json_encode( $payload ) );
		if ( null === $encrypted ) {
			return false;
		}

		$wpdb->insert(
			self::table_name(),
			array(
				'event_id'        => $event_id,
				'payload'         => $encrypted,
				'attempts'        => 1,
				'status'          => 'pending',
				'next_attempt_at' => self::next_attempt_time( 2 ),
				'created_at'      => current_time( 'mysql' ),
			),
			array( '%s', '%s', '%d', '%s', '%s', '%s' )
		);
		return true;
	}

	/** Bounded exponential backoff — attempt 2 -> 1min, 3 -> 5min, 4 -> 15min, 5 -> 1hr. */
	private static function backoff_seconds( $upcoming_attempt_number ) {
		$schedule = array(
			2 => 60,
			3 => 300,
			4 => 900,
			5 => 3600,
		);
		return isset( $schedule[ $upcoming_attempt_number ] ) ? $schedule[ $upcoming_attempt_number ] : 3600;
	}

	private static function next_attempt_time( $upcoming_attempt_number ) {
		$seconds = self::backoff_seconds( $upcoming_attempt_number );
		return gmdate( 'Y-m-d H:i:s', time() + $seconds );
	}

	/**
	 * Atomically claims up to $limit due rows for THIS invocation and
	 * returns them with their payload already decrypted.
	 *
	 * The claim itself is a single UPDATE ... WHERE status='pending' (or a
	 * 'processing' row whose lease already expired) ... LIMIT $limit,
	 * tagged with a fresh random claimed_token. InnoDB row locks make this
	 * UPDATE atomic per-row: if two WP-Cron runs execute this at nearly
	 * the same moment, each row can only be matched by whichever UPDATE's
	 * row lock wins first — the second UPDATE simply won't see that row as
	 * 'pending' anymore, since the SQL engine serializes the two writers
	 * against the same rows. This is what actually prevents the same
	 * queued submission from being sent twice by two overlapping cron
	 * runs, not application-level logic.
	 */
	public static function claim_due_items( $limit = 20 ) {
		global $wpdb;
		$table_name = self::table_name();
		$claim_token = wp_generate_uuid4();
		$now = current_time( 'mysql' );
		$processing_until = gmdate( 'Y-m-d H:i:s', time() + self::CLAIM_LEASE_SECONDS );

		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$table_name}
				 SET status = 'processing', claimed_token = %s, processing_until = %s
				 WHERE (status = 'pending' OR (status = 'processing' AND processing_until < %s))
				   AND next_attempt_at <= %s
				 ORDER BY next_attempt_at ASC
				 LIMIT %d",
				$claim_token,
				$processing_until,
				$now,
				$now,
				$limit
			)
		);

		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$table_name} WHERE claimed_token = %s", $claim_token )
		);

		$decrypted_rows = array();
		foreach ( $rows as $row ) {
			$plaintext = self::decrypt_payload( $row->payload );
			if ( null === $plaintext ) {
				// Corrupt/undecryptable (e.g. a key rotation happened while
				// this row was queued) — cannot be processed; discard rather
				// than retry forever or crash the whole cron run.
				self::mark_permanent_failure( $row->id );
				continue;
			}
			$row->decoded_payload = json_decode( $plaintext, true );
			$decrypted_rows[] = $row;
		}
		return $decrypted_rows;
	}

	/** Success — delete the row entirely (Section 20: don't retain submission data longer than needed). */
	public static function mark_success( $id ) {
		global $wpdb;
		$wpdb->delete( self::table_name(), array( 'id' => $id ), array( '%d' ) );
	}

	/**
	 * Temporary failure — bump attempts and reschedule (releasing the
	 * claim back to 'pending' so a future cron run can pick it up again),
	 * or give up past MAX_ATTEMPTS.
	 */
	public static function mark_retry_or_fail( $row ) {
		global $wpdb;
		$next_attempt_number = (int) $row->attempts + 1;

		if ( $next_attempt_number > self::MAX_ATTEMPTS ) {
			$wpdb->update(
				self::table_name(),
				array( 'status' => 'failed', 'claimed_token' => null, 'processing_until' => null ),
				array( 'id' => $row->id ),
				array( '%s', '%s', '%s' ),
				array( '%d' )
			);
			return;
		}

		$wpdb->update(
			self::table_name(),
			array(
				'attempts'         => $next_attempt_number,
				'next_attempt_at'  => self::next_attempt_time( $next_attempt_number ),
				'status'           => 'pending',
				'claimed_token'    => null,
				'processing_until' => null,
			),
			array( 'id' => $row->id ),
			array( '%d', '%s', '%s', '%s', '%s' ),
			array( '%d' )
		);
	}

	/** Permanent error (e.g. 400/401) — no point retrying; remove immediately rather than let it churn until MAX_ATTEMPTS. */
	public static function mark_permanent_failure( $id ) {
		self::mark_success( $id ); // same action (delete) — named separately for call-site clarity/intent.
	}

	/**
	 * Reasonable retention policy (Section 20): failed rows older than 7
	 * days are purged rather than kept indefinitely. Run from the same
	 * cron callback that processes the queue (class-odito-cf7-capture.php).
	 */
	public static function cleanup_old_failed() {
		global $wpdb;
		$table_name = self::table_name();
		$cutoff = gmdate( 'Y-m-d H:i:s', time() - ( self::RETENTION_DAYS_FAILED * DAY_IN_SECONDS ) );
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$table_name} WHERE status = 'failed' AND created_at < %s",
				$cutoff
			)
		);
	}

	/** Local-only counts for the admin settings page (Section 33) — never sent to Odito. */
	public static function get_status_counts() {
		global $wpdb;
		$table_name = self::table_name();
		$pending = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table_name} WHERE status IN ('pending', 'processing')" );
		$failed = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table_name} WHERE status = 'failed'" );
		return array( 'pending' => $pending, 'failed' => $failed );
	}
}
