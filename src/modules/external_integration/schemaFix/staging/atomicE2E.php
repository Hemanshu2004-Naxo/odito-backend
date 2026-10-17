<?php
/**
 * STAGING-ONLY failure-injection check of the Odito SEO Bridge 1.5.0 conditional writes (Atomic::swap_option and Media_Alt::swap)
 * against a disposable local WordPress. Never run it against a production site.
 *
 *   php wp-cli.phar --path=<staging-wordpress> eval-file atomicE2E.php
 *
 * A "concurrent writer" is simulated by changing the stored value from INSIDE the mutator, i.e. after the Bridge has read the
 * value and before it writes — the exact window a real second request would use. The script restores everything it touches.
 */

use Odito\SeoBridge\Atomic;
use Odito\SeoBridge\Conflict_Exception;
use Odito\SeoBridge\Media_Alt;

if ( ! defined( 'WP_CLI' ) ) {
	fwrite( STDERR, "Run this through WP-CLI eval-file.\n" );
	exit( 1 );
}

$GLOBALS['odito_e2e'] = array( 'pass' => 0, 'fail' => 0 );

function odito_e2e_check( $label, $condition, $detail = '' ) {
	$GLOBALS['odito_e2e'][ $condition ? 'pass' : 'fail' ]++;
	echo ( $condition ? '  PASS  ' : '  FAIL  ' ) . $label . ( $condition || '' === $detail ? '' : "  -> $detail" ) . "\n";
}

function odito_e2e_call( $method, $route, $params = array() ) {
	$request = new WP_REST_Request( $method, '/odito/v1' . $route );
	foreach ( $params as $key => $value ) {
		$request->set_param( $key, $value );
	}
	$response = rest_do_request( $request );
	return array( $response->get_status(), $response->get_data() );
}

/** Change an option behind the Bridge's back with raw SQL (what a second request does). */
function odito_e2e_raw_option( $name, $array ) {
	global $wpdb;
	$wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s", maybe_serialize( $array ), $name ) );
	wp_cache_delete( $name, 'options' );
	wp_cache_delete( 'alloptions', 'options' );
}

function odito_e2e_run() {
	global $wpdb;
	$opt      = 'odito_e2e_atomic_option';
	$titles   = 'rank-math-options-titles';
	$snapshot = get_option( $titles, null );
	$created  = array();

	echo 'Bridge ' . ODITO_SEO_BRIDGE_VERSION . "\n";

	try {
		wp_set_current_user( 1 );

		// ── Atomic::swap_option ─────────────────────────────────────────────────────────────────────────────────────
		echo "swap_option\n";
		delete_option( $opt );
		$attempts = Atomic::swap_option( $opt, function ( $c ) { $c['a'] = '1'; return $c; } );
		odito_e2e_check( 'creates a missing option', 1 === $attempts && array( 'a' => '1' ) === get_option( $opt ) );

		$attempts = Atomic::swap_option( $opt, function ( $c ) { $c['a'] = '2'; return $c; } );
		odito_e2e_check( 'updates an existing option with one conditional UPDATE', 1 === $attempts && '2' === get_option( $opt )['a'] );

		// A concurrent writer saves a DIFFERENT key between our read and our write: neither change may be lost.
		$interfered = false;
		$attempts   = Atomic::swap_option( $opt, function ( $c ) use ( &$interfered, $opt ) {
			if ( ! $interfered ) {
				$interfered = true;
				odito_e2e_raw_option( $opt, array( 'a' => '2', 'other' => 'human edit' ) );
			}
			$c['a'] = '3';
			return $c;
		} );
		$now = get_option( $opt );
		odito_e2e_check( 'a concurrent save is detected (first attempt matched zero rows) and retried', $attempts >= 2, (string) $attempts );
		odito_e2e_check( 'the concurrent writer\'s different setting survives (no lost update)', 'human edit' === ( $now['other'] ?? null ), json_encode( $now ) );
		odito_e2e_check( 'and Odito\'s change landed on top of it', '3' === ( $now['a'] ?? null ), json_encode( $now ) );

		// The caller's expected value is checked against the FRESH state on every attempt.
		$interfered = false;
		$threw      = null;
		try {
			Atomic::swap_option( $opt, function ( $c ) use ( &$interfered, $opt ) {
				if ( ! $interfered ) {
					$interfered = true;
					odito_e2e_raw_option( $opt, array( 'a' => 'someone else', 'other' => 'human edit' ) );
				}
				if ( '3' !== ( $c['a'] ?? '' ) ) {
					throw new Conflict_Exception( 'changed', 'expected_mismatch' );
				}
				$c['a'] = '4';
				return $c;
			} );
		} catch ( Conflict_Exception $e ) {
			$threw = $e;
		}
		odito_e2e_check( 'when the concurrent edit changes the EXPECTED field, the write is refused', $threw && 'expected_mismatch' === $threw->reason );
		odito_e2e_check( 'and the other writer\'s value is untouched', 'someone else' === get_option( $opt )['a'] );

		// A value that keeps changing is reported, never overwritten.
		$counter = 0;
		$threw   = null;
		try {
			Atomic::swap_option( $opt, function ( $c ) use ( &$counter, $opt ) {
				$counter++;
				odito_e2e_raw_option( $opt, array( 'a' => 'busy ' . $counter ) );
				$c['a'] = 'never';
				return $c;
			}, 3 );
		} catch ( Conflict_Exception $e ) {
			$threw = $e;
		}
		odito_e2e_check( 'a value changing on every attempt ends in a bounded `contention` conflict', $threw && 'contention' === $threw->reason && 3 === $counter, $threw ? $threw->reason . " after $counter" : 'no exception' );
		odito_e2e_check( 'and Odito never wrote over it', 'busy 3' === get_option( $opt )['a'] );

		$attempts = Atomic::swap_option( $opt, function ( $c ) { return $c; } );
		odito_e2e_check( 'an unchanged value is a no-op', 1 === $attempts );
		delete_option( $opt );

		// ── Organization through the REST route: operation audit data ───────────────────────────────────────────────
		echo "organization REST write\n";
		$t                        = (array) get_option( $titles, array() );
		$t['knowledgegraph_type'] = 'company';
		$t['knowledgegraph_name'] = '';
		update_option( $titles, $t );
		list( $code, $data ) = odito_e2e_call( 'PUT', '/seo/site', array( 'entity' => 'organization', 'field' => 'name', 'value' => 'Atomic Clinic', 'expected' => '' ) );
		odito_e2e_check( 'the write reports an atomic operation with an id', 200 === $code && ! empty( $data['operation']['id'] ) && true === $data['operation']['atomic'], json_encode( $data['operation'] ?? null ) );
		list( $code, $data ) = odito_e2e_call( 'PUT', '/seo/site', array( 'entity' => 'organization', 'field' => 'name', 'value' => 'Overwrite', 'expected' => 'wrong' ) );
		odito_e2e_check( 'a stale expected value gives 409 with reason expected_mismatch', 409 === $code && 'expected_mismatch' === ( $data['data']['reason'] ?? '' ), "$code " . json_encode( $data ) );

		// ── Media alt ───────────────────────────────────────────────────────────────────────────────────────────────
		echo "media alt\n";
		$upload  = wp_upload_dir();
		$make    = function ( $name ) use ( &$created ) {
			$id = wp_insert_post( array( 'post_type' => 'attachment', 'post_mime_type' => 'image/png', 'post_title' => $name, 'post_status' => 'inherit' ) );
			update_post_meta( $id, '_wp_attached_file', '2026/10/' . $name . '.png' );
			$created[] = $id;
			return $id;
		};
		$a = $make( 'odito-e2e-a' );
		$b = $make( 'odito-e2e-b' );
		$fa = '2026/10/odito-e2e-a.png';

		if ( ! wp_attachment_is_image( $a ) ) {
			odito_e2e_check( 'the test attachment counts as an image', false, 'wp_attachment_is_image is false in this environment' );
			return;
		}

		list( $code, $data ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'A clinic reception desk', 'expected' => '', 'expectedFile' => $fa ) );
		odito_e2e_check( 'creating alt text on an image with none works and says it was NOT a database-atomic write', 200 === $code && 'A clinic reception desk' === $data['alt'] && false === $data['operation']['atomic'] && true === $data['operation']['created'], "$code " . json_encode( $data ) );

		list( $code, $data ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'A clinic reception desk', 'expected' => '', 'expectedFile' => $fa ) );
		odito_e2e_check( 'repeating the same request after it landed (ambiguous-timeout retry) is reported as alreadyApplied, not written twice', 200 === $code && true === $data['operation']['alreadyApplied'], "$code " . json_encode( $data ) );
		odito_e2e_check( 'nothing changed', 'A clinic reception desk' === get_post_meta( $a, '_wp_attachment_image_alt', true ) );

		list( $code, $data ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'Reception desk with two chairs', 'expected' => 'A clinic reception desk', 'expectedFile' => $fa ) );
		odito_e2e_check( 'updating an existing alt uses a conditional UPDATE (atomic)', 200 === $code && true === $data['operation']['atomic'] && 'Reception desk with two chairs' === $data['alt'], "$code " . json_encode( $data ) );

		list( $code, $data ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'Reception desk with two chairs', 'expected' => 'A clinic reception desk', 'expectedFile' => $fa ) );
		odito_e2e_check( 'the identical retry after the write landed reports alreadyApplied (not an error, not a second write)', 200 === $code && true === $data['operation']['alreadyApplied'], "$code " . json_encode( $data ) );

		list( $code, $data ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'Something else', 'expected' => 'A clinic reception desk', 'expectedFile' => $fa ) );
		odito_e2e_check( 'a different value against an outdated expected is a 409 and writes nothing', 409 === $code && 'Reception desk with two chairs' === get_post_meta( $a, '_wp_attachment_image_alt', true ) );

		// A human edits the alt after Odito read it: simulate with raw SQL, then send the stale expectation.
		$wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->postmeta} SET meta_value = %s WHERE post_id = %d AND meta_key = '_wp_attachment_image_alt'", 'Edited by a person', $a ) );
		wp_cache_delete( $a, 'post_meta' );
		list( $code ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'Odito text', 'expected' => 'Reception desk with two chairs', 'expectedFile' => $fa ) );
		odito_e2e_check( 'a person\'s edit between read and write is never overwritten', 409 === $code && 'Edited by a person' === get_post_meta( $a, '_wp_attachment_image_alt', true ) );

		echo "media alt identity\n";
		list( $code, $data ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'Odito text', 'expected' => 'Edited by a person', 'expectedFile' => '2026/10/another-image.png' ) );
		odito_e2e_check( 'a file that is not the approved file is refused as target_changed', 409 === $code && 'target_changed' === ( $data['data']['reason'] ?? '' ), "$code " . json_encode( $data ) );
		list( $code, $data ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'Odito text', 'expected' => 'Edited by a person', 'expectedFile' => '' ) );
		odito_e2e_check( 'an empty expectedFile is refused too', 409 === $code, (string) $code );
		list( $code ) = odito_e2e_call( 'PUT', "/media/$b/alt", array( 'value' => 'Wrong image', 'expected' => '', 'expectedFile' => $fa ) );
		odito_e2e_check( 'the approved file of image A cannot be used to write image B', 409 === $code && '' === get_post_meta( $b, '_wp_attachment_image_alt', true ) );

		add_post_meta( $b, '_wp_attachment_image_alt', 'first' );
		add_post_meta( $b, '_wp_attachment_image_alt', 'second' );
		list( $code, $data ) = odito_e2e_call( 'PUT', "/media/$b/alt", array( 'value' => 'x', 'expected' => 'first', 'expectedFile' => '2026/10/odito-e2e-b.png' ) );
		odito_e2e_check( 'two alt rows on one attachment are refused as ambiguous_meta', 409 === $code && 'ambiguous_meta' === ( $data['data']['reason'] ?? '' ), "$code " . json_encode( $data ) );

		echo "media alt request validation\n";
		$post = wp_insert_post( array( 'post_title' => 'odito-e2e page', 'post_status' => 'draft' ) );
		$created[] = $post;
		list( $code ) = odito_e2e_call( 'PUT', "/media/$post/alt", array( 'value' => 'x', 'expected' => '', 'expectedFile' => 'f' ) );
		odito_e2e_check( 'a post that is not an image attachment is 404', 404 === $code, (string) $code );
		list( $code ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => '<b>bold</b>', 'expected' => 'Edited by a person', 'expectedFile' => $fa ) );
		odito_e2e_check( 'HTML in the value is rejected (400)', 400 === $code, (string) $code );
		list( $code ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => str_repeat( 'a', 300 ), 'expected' => 'Edited by a person', 'expectedFile' => $fa ) );
		odito_e2e_check( 'an over-long value is rejected (400) and never truncated', 400 === $code );
		list( $code ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'ok', 'expectedFile' => $fa ) );
		odito_e2e_check( 'a request without `expected` is rejected (400)', 400 === $code, (string) $code );
		list( $code ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'Odito text', 'expected' => 'Edited by a person', 'expectedFile' => $fa, 'meta_key' => '_wp_attached_file', 'field' => 'title' ) );
		odito_e2e_check( 'extra "field"/"meta_key" parameters are ignored — only alt text is ever written', 200 === $code && $fa === get_post_meta( $a, '_wp_attached_file', true ) && 'odito-e2e-a' === get_post( $a )->post_title, (string) $code );

		echo "media alt permissions\n";
		wp_set_current_user( 2 );
		list( $code ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'Subscriber', 'expected' => 'Odito text', 'expectedFile' => $fa ) );
		odito_e2e_check( 'a subscriber gets 403', 403 === $code, (string) $code );
		list( $code ) = odito_e2e_call( 'GET', "/media/$a/alt" );
		odito_e2e_check( 'and cannot read it through the Bridge either', 403 === $code, (string) $code );
		wp_set_current_user( 0 );
		list( $code ) = odito_e2e_call( 'PUT', "/media/$a/alt", array( 'value' => 'Anon', 'expected' => 'Odito text', 'expectedFile' => $fa ) );
		odito_e2e_check( 'an anonymous request gets 401', 401 === $code, (string) $code );
		wp_set_current_user( 1 );
		odito_e2e_check( 'neither attempt changed anything', 'Odito text' === get_post_meta( $a, '_wp_attachment_image_alt', true ) );

		list( $code, $data ) = odito_e2e_call( 'GET', '/status' );
		odito_e2e_check( 'status reports supports.media_alt', 200 === $code && ! empty( $data['supports']['media_alt'] ), json_encode( $data['supports'] ?? null ) );
	} catch ( \Throwable $e ) {
		odito_e2e_check( 'no unexpected exception', false, get_class( $e ) . ': ' . $e->getMessage() );
	} finally {
		delete_option( $opt );
		if ( null === $snapshot ) {
			delete_option( $titles );
		} else {
			update_option( $titles, $snapshot );
		}
		foreach ( $created as $id ) {
			wp_delete_post( $id, true );
		}
		echo "\nrestored the Rank Math options and removed the test posts/attachments\n";
	}

	echo sprintf( "\n%d passed, %d failed\n", $GLOBALS['odito_e2e']['pass'], $GLOBALS['odito_e2e']['fail'] );
	exit( $GLOBALS['odito_e2e']['fail'] > 0 ? 1 : 0 );
}

odito_e2e_run();
