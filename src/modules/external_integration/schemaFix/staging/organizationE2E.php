<?php
/**
 * STAGING-ONLY end-to-end check of the Odito SEO Bridge's Organization identity writes against the REAL Rank Math code.
 *
 * Run it against a disposable local WordPress (never a production site), through WP-CLI:
 *
 *   php wp-cli.phar --path=<staging-wordpress> eval-file organizationE2E.php
 *
 * That runs the write/permission/compare-and-set checks and restores the two Rank Math options it touches.
 *
 * To also see what Rank Math really PUBLISHES, use two separate processes (Rank Math caches its settings in memory at load):
 *
 *   ODITO_E2E_PHASE=prepare php wp-cli.phar --path=<wp> --exec='define("RANK_MATH_REGISTRATION_SKIP", true);' eval-file organizationE2E.php
 *   ODITO_E2E_PHASE=render  php wp-cli.phar --path=<wp> --exec='define("RANK_MATH_REGISTRATION_SKIP", true);' eval-file organizationE2E.php
 *
 * `prepare` writes a company/Hospital configuration through the Bridge's REST routes (the real write path), keeps it, and
 * saves a snapshot of the original options. `render` renders the front page <head>, inspects the JSON-LD Rank Math
 * publishes, then restores the snapshot. RANK_MATH_REGISTRATION_SKIP is Rank Math's own constant (the "skip registration"
 * choice): it only lets Rank Math's frontend run on a staging site that is not connected to a Rank Math account.
 * No network requests are made.
 */

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

function odito_e2e_site() {
	list( , $data ) = odito_e2e_call( 'GET', '/seo/site' );
	return $data['organization'] ?? array();
}

function odito_e2e_put( $field, $value, $extra = array() ) {
	return odito_e2e_call( 'PUT', '/seo/site', array_merge( array( 'entity' => 'organization', 'field' => $field, 'value' => $value ), $extra ) );
}

function odito_e2e_restore( $snapshot ) {
	foreach ( $snapshot as $name => $value ) {
		if ( null === $value ) {
			delete_option( $name );
		} else {
			update_option( $name, $value );
		}
	}
}

function odito_e2e_finish() {
	echo sprintf( "\n%d passed, %d failed\n", $GLOBALS['odito_e2e']['pass'], $GLOBALS['odito_e2e']['fail'] );
	exit( $GLOBALS['odito_e2e']['fail'] > 0 ? 1 : 0 );
}

function odito_e2e_run( $phase ) {
	$opt_titles    = 'rank-math-options-titles';
	$opt_general   = 'rank-math-options-general';
	$opt_modules   = 'rank_math_modules';
	$snapshot_file = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'odito_e2e_rank_math_snapshot.json';

	echo 'Bridge ' . ODITO_SEO_BRIDGE_VERSION . ' / Rank Math ' . ( defined( 'RANK_MATH_VERSION' ) ? RANK_MATH_VERSION : 'n/a' ) . " / phase $phase\n";

	// ── render: what Rank Math really publishes ─────────────────────────────────────────────────────────────────────
	if ( 'render' === $phase ) {
		$snapshot = is_readable( $snapshot_file ) ? json_decode( (string) file_get_contents( $snapshot_file ), true ) : null;
		odito_e2e_check( 'a snapshot from the prepare phase exists (so the staging site can be restored)', is_array( $snapshot ) );
		try {
			$_SERVER['REQUEST_URI'] = '/';
			$_SERVER['SERVER_NAME'] = 'localhost';
			$GLOBALS['wp']->main(); // parse the request for the front page, then print <head> exactly as a theme would
			ob_start();
			do_action( 'wp_head' );
			$html = ob_get_clean();

			preg_match_all( '#<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>#s', $html, $m );
			$nodes = array();
			foreach ( $m[1] as $json ) {
				$decoded = json_decode( $json, true );
				foreach ( isset( $decoded['@graph'] ) ? $decoded['@graph'] : array( $decoded ) as $node ) {
					$nodes[] = $node;
				}
			}
			$orgs    = array_values( array_filter( $nodes, function ( $n ) {
				$t = (array) ( $n['@type'] ?? array() );
				return in_array( 'Hospital', $t, true ) || in_array( 'Organization', $t, true ) || in_array( 'LocalBusiness', $t, true );
			} ) );
			$persons = array_filter( $nodes, function ( $n ) {
				return in_array( 'Person', (array) ( $n['@type'] ?? array() ), true );
			} );

			odito_e2e_check( 'exactly one organization-type entity is rendered', 1 === count( $orgs ), 'found ' . count( $orgs ) );
			odito_e2e_check( 'and no Person entity (the site is a company)', 0 === count( $persons ), (string) count( $persons ) );
			if ( 1 === count( $orgs ) ) {
				$o     = $orgs[0];
				$types = (array) $o['@type'];
				odito_e2e_check( 'its @type is Hospital', in_array( 'Hospital', $types, true ), json_encode( $types ) );
				odito_e2e_check( 'its @id is <home>/#organization', ( trailingslashit( home_url() ) . '#organization' ) === ( $o['@id'] ?? '' ), (string) ( $o['@id'] ?? '' ) );
				odito_e2e_check( 'its name is the one the Bridge wrote', 'Clinic Eye Centre Mumbai' === ( $o['name'] ?? '' ), (string) ( $o['name'] ?? '' ) );
				echo '  entity: ' . json_encode( array_intersect_key( $o, array_flip( array( '@type', '@id', 'name', 'url', 'logo' ) ) ) ) . "\n";
			}
		} catch ( \Throwable $e ) {
			odito_e2e_check( 'no unexpected exception', false, $e->getMessage() );
		} finally {
			if ( is_array( $snapshot ) ) {
				odito_e2e_restore( $snapshot );
				@unlink( $snapshot_file );
				echo "restored the two Rank Math options to their previous values\n";
			}
		}
		odito_e2e_finish();
	}

	// ── prepare / checks both start from a snapshot of the two options ──────────────────────────────────────────────
	$snapshot = array( $opt_titles => get_option( $opt_titles, null ), $opt_general => get_option( $opt_general, null ), $opt_modules => get_option( $opt_modules, null ) );
	$keep     = false;

	try {
		wp_set_current_user( 1 ); // the administrator the Application Password belongs to

		if ( 'prepare' === $phase ) {
			file_put_contents( $snapshot_file, json_encode( $snapshot ) );
			$keep                          = true;
			// Rank Math only publishes the business type while its Local SEO module is on (the Bridge reports this as localSeoActive).
			$before = odito_e2e_site();
			odito_e2e_check( 'the Bridge reports Local SEO as OFF on this site before it is enabled', false === ( $before['localSeoActive'] ?? null ), json_encode( $before ) );
			$modules   = (array) get_option( $opt_modules, array() );
			$modules[] = 'local-seo';
			update_option( $opt_modules, array_values( array_unique( $modules ) ) );
			odito_e2e_check( 'and as ON once the module is enabled', true === ( odito_e2e_site()['localSeoActive'] ?? null ) );
			$titles                        = (array) get_option( $opt_titles, array() );
			$titles['knowledgegraph_type'] = 'company';
			$titles['knowledgegraph_name'] = '';
			$titles['local_business_type'] = 'Organization';
			update_option( $opt_titles, $titles );
			list( $code ) = odito_e2e_put( 'name', 'Clinic Eye Centre Mumbai', array( 'expected' => '' ) );
			odito_e2e_check( 'the Bridge wrote the name', 200 === $code );
			list( $code ) = odito_e2e_put( 'type', 'Hospital', array( 'expected' => 'Organization' ) );
			odito_e2e_check( 'the Bridge wrote the type', 200 === $code );
			odito_e2e_check( 'both are stored', 'Hospital' === odito_e2e_site()['type'] && 'Clinic Eye Centre Mumbai' === odito_e2e_site()['name'] );
			echo "left in place for the render phase\n";
			odito_e2e_finish();
		}

		echo "status\n";
		list( $code, $status ) = odito_e2e_call( 'GET', '/status' );
		odito_e2e_check( 'reports provider rank_math', 200 === $code && 'rank_math' === $status['provider'], json_encode( $status ) );
		odito_e2e_check( 'supports.organization_type is true', ! empty( $status['supports']['organization_type'] ) );
		odito_e2e_check( 'supports.site_schema is true', ! empty( $status['supports']['site_schema'] ) );

		// A clean, known starting point.
		$titles                           = (array) get_option( $opt_titles, array() );
		$titles['knowledgegraph_type']    = 'person';
		$titles['knowledgegraph_name']    = '';
		$titles['knowledgegraph_logo']    = '';
		$titles['knowledgegraph_logo_id'] = '';
		$titles['local_business_type']    = 'Organization';
		$titles['local_address']          = array();
		update_option( $opt_titles, $titles );

		echo "site schema read\n";
		$org = odito_e2e_site();
		odito_e2e_check( 'kind is person', 'person' === ( $org['kind'] ?? null ), json_encode( $org ) );
		odito_e2e_check( 'type is Organization', 'Organization' === ( $org['type'] ?? null ) );
		odito_e2e_check( 'hasAddress is false when no address is configured', false === ( $org['hasAddress'] ?? null ) );

		echo "type refused while the site is a person\n";
		list( $code, $data ) = odito_e2e_put( 'type', 'Hospital', array( 'expected' => 'Organization' ) );
		odito_e2e_check( 'write is refused (not silently ignored)', 500 === $code && false !== strpos( (string) ( $data['message'] ?? '' ), 'person' ), "$code " . json_encode( $data ) );
		odito_e2e_check( 'stored type unchanged', 'Organization' === odito_e2e_site()['type'] );

		$titles                        = (array) get_option( $opt_titles, array() );
		$titles['knowledgegraph_type'] = 'company';
		update_option( $opt_titles, $titles );

		echo "compare-and-set\n";
		list( $code ) = odito_e2e_put( 'name', 'Clinic Eye Centre', array( 'expected' => '' ) );
		odito_e2e_check( 'name written when the stored value matches expected', 200 === $code && 'Clinic Eye Centre' === odito_e2e_site()['name'] );
		list( $code, $data ) = odito_e2e_put( 'name', 'Overwrite attempt', array( 'expected' => '' ) );
		odito_e2e_check( 'a stale expected value is refused with 409 odito_conflict', 409 === $code && 'odito_conflict' === ( $data['code'] ?? '' ), "$code " . json_encode( $data ) );
		odito_e2e_check( 'and the stored value is untouched', 'Clinic Eye Centre' === odito_e2e_site()['name'] );
		list( $code ) = odito_e2e_put( 'name', 'Clinic Eye Centre Mumbai' );
		odito_e2e_check( 'a write without expected still works (the existing contract is unchanged)', 200 === $code && 'Clinic Eye Centre Mumbai' === odito_e2e_site()['name'] );
		list( $code, $data ) = odito_e2e_call( 'PUT', '/seo/site', array( 'entity' => 'organization', 'field' => 'sameAs', 'value' => 'https://example.org/a', 'op' => 'add', 'expected' => '' ) );
		odito_e2e_check( 'expected is rejected for sameAs', 400 === $code, "$code " . json_encode( $data ) );

		echo "organization type\n";
		list( $code, $data ) = odito_e2e_put( 'type', 'NotARealBusinessType', array( 'expected' => 'Organization' ) );
		odito_e2e_check( 'a type outside Rank Math\'s own list is refused', 500 === $code, "$code " . json_encode( $data ) );
		list( $code, $data ) = odito_e2e_put( 'type', 'Hos pital!', array( 'expected' => 'Organization' ) );
		odito_e2e_check( 'a malformed type is refused (400)', 400 === $code, "$code " . json_encode( $data ) );
		list( $code ) = odito_e2e_put( 'type', 'Hospital', array( 'expected' => 'Organization' ) );
		odito_e2e_check( 'Hospital is accepted', 200 === $code && 'Hospital' === odito_e2e_site()['type'] );
		list( $code ) = odito_e2e_put( 'type', 'Dentist', array( 'expected' => 'Organization' ) );
		odito_e2e_check( 'a compare-and-set against an outdated type is refused', 409 === $code && 'Hospital' === odito_e2e_site()['type'] );

		echo "logo keeps its attachment id in step\n";
		$titles                           = (array) get_option( $opt_titles, array() );
		$titles['knowledgegraph_logo_id'] = 99999; // a stale id left by a previous logo
		update_option( $opt_titles, $titles );
		list( $code ) = odito_e2e_put( 'logo', home_url( '/wp-content/uploads/not-an-attachment.png' ), array( 'expected' => '' ) );
		$stored = (array) get_option( $opt_titles, array() );
		odito_e2e_check( 'logo written', 200 === $code && '' !== ( $stored['knowledgegraph_logo'] ?? '' ) );
		odito_e2e_check( 'a stale logo id is cleared, never kept next to the new URL', '' === (string) ( $stored['knowledgegraph_logo_id'] ?? 'x' ), json_encode( $stored['knowledgegraph_logo_id'] ?? null ) );

		echo "clear (the rollback primitive)\n";
		list( $code, $data ) = odito_e2e_call( 'PUT', '/seo/site', array( 'entity' => 'organization', 'field' => 'type', 'op' => 'clear' ) );
		odito_e2e_check( 'clear without expected is refused', 400 === $code, "$code " . json_encode( $data ) );
		list( $code ) = odito_e2e_call( 'PUT', '/seo/site', array( 'entity' => 'organization', 'field' => 'type', 'op' => 'clear', 'expected' => 'Hospital' ) );
		odito_e2e_check( 'clear with the right expected value restores empty', 200 === $code && '' === odito_e2e_site()['type'] );
		list( $code ) = odito_e2e_call( 'PUT', '/seo/site', array( 'entity' => 'organization', 'field' => 'name', 'op' => 'clear', 'expected' => 'wrong' ) );
		odito_e2e_check( 'clear with a wrong expected value is a 409 and changes nothing', 409 === $code && 'Clinic Eye Centre Mumbai' === odito_e2e_site()['name'] );

		echo "permissions\n";
		wp_set_current_user( 2 ); // subscriber
		list( $code ) = odito_e2e_put( 'name', 'Subscriber write', array( 'expected' => 'Clinic Eye Centre Mumbai' ) );
		odito_e2e_check( 'a user without manage_options gets 403', 403 === $code, (string) $code );
		wp_set_current_user( 0 );
		list( $code ) = odito_e2e_call( 'GET', '/seo/site' );
		odito_e2e_check( 'an unauthenticated request gets 401', 401 === $code, (string) $code );
		wp_set_current_user( 1 );
		odito_e2e_check( 'the subscriber attempt changed nothing', 'Clinic Eye Centre Mumbai' === odito_e2e_site()['name'] );

		echo "address detection\n";
		$titles                  = (array) get_option( $opt_titles, array() );
		$titles['local_address'] = array( 'streetAddress' => '2-A Trust House', 'addressLocality' => 'Parel', 'addressRegion' => 'MH', 'postalCode' => '400012', 'addressCountry' => 'IN' );
		update_option( $opt_titles, $titles );
		odito_e2e_check( 'hasAddress is true once a street address exists', true === odito_e2e_site()['hasAddress'] );
	} catch ( \Throwable $e ) {
		odito_e2e_check( 'no unexpected exception', false, $e->getMessage() );
	} finally {
		if ( ! $keep ) {
			odito_e2e_restore( $snapshot );
			echo "\nrestored the two Rank Math options to their previous values\n";
		}
	}

	odito_e2e_finish();
}

odito_e2e_run( getenv( 'ODITO_E2E_PHASE' ) ? getenv( 'ODITO_E2E_PHASE' ) : 'checks' );
