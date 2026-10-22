<?php
/**
 * STAGING-ONLY end-to-end check of the Odito SEO Bridge's Organization ADDRESS write (Bridge 1.6.0) against the REAL Rank Math
 * code. Run it against a disposable local WordPress (never a production site), through WP-CLI:
 *
 *   php wp-cli.phar --path=<staging-wordpress> eval-file organizationAddressE2E.php
 *
 * That runs the write / validation / compare-and-set / clear / permission checks and restores the Rank Math options it touches.
 *
 * To also see what Rank Math really PUBLISHES for the address (it caches settings in memory at load, so use separate processes):
 *
 *   ODITO_E2E_PHASE=prepare php wp-cli.phar --path=<wp> --exec='define("RANK_MATH_REGISTRATION_SKIP", true);' eval-file organizationAddressE2E.php
 *   ODITO_E2E_PHASE=render  php wp-cli.phar --path=<wp> --exec='define("RANK_MATH_REGISTRATION_SKIP", true);' eval-file organizationAddressE2E.php
 *
 *   ODITO_E2E_LOCAL_SEO=off makes the prepare phase leave Rank Math's Local SEO module OFF, to prove the address is then NOT published.
 *
 * All names and addresses are fictional test data. No network requests are made.
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

const ODITO_E2E_ADDRESS = array(
	'streetAddress'   => '14 Lakeview Road',
	'addressLocality' => 'Rivertown',
	'addressRegion'   => 'Karnataka',
	'postalCode'      => '560001',
	'addressCountry'  => 'IN',
);

function odito_e2e_run( $phase ) {
	$opt_titles    = 'rank-math-options-titles';
	$opt_general   = 'rank-math-options-general';
	$opt_modules   = 'rank_math_modules';
	$snapshot_file = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'odito_e2e_address_snapshot.json';
	$json          = function ( $a ) { return wp_json_encode( $a ); };

	echo 'Bridge ' . ODITO_SEO_BRIDGE_VERSION . ' / Rank Math ' . ( defined( 'RANK_MATH_VERSION' ) ? RANK_MATH_VERSION : 'n/a' ) . " / phase $phase\n";

	// ── render: what Rank Math really publishes ─────────────────────────────────────────────────────────────────────
	if ( 'render' === $phase ) {
		$snapshot = is_readable( $snapshot_file ) ? json_decode( (string) file_get_contents( $snapshot_file ), true ) : null;
		odito_e2e_check( 'a snapshot from the prepare phase exists (so the staging site can be restored)', is_array( $snapshot ) );
		try {
			$_SERVER['REQUEST_URI'] = '/';
			$_SERVER['SERVER_NAME'] = 'localhost';
			$GLOBALS['wp']->main();
			ob_start();
			do_action( 'wp_head' );
			$html = ob_get_clean();

			preg_match_all( '#<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>#s', $html, $m );
			$nodes = array();
			foreach ( $m[1] as $block ) {
				$decoded = json_decode( $block, true );
				foreach ( isset( $decoded['@graph'] ) ? $decoded['@graph'] : array( $decoded ) as $node ) {
					$nodes[] = $node;
				}
			}
			$orgs = array_values( array_filter( $nodes, function ( $n ) {
				$t = (array) ( $n['@type'] ?? array() );
				return in_array( 'Organization', $t, true ) || in_array( 'LocalBusiness', $t, true ) || in_array( 'Hospital', $t, true );
			} ) );
			$local_seo_expected = ( 'on' === ( $snapshot['__expect_local_seo'] ?? 'on' ) );

			odito_e2e_check( 'exactly one organization-type entity is rendered (no duplicate)', 1 === count( $orgs ), 'found ' . count( $orgs ) );
			if ( 1 === count( $orgs ) ) {
				$o = $orgs[0];
				odito_e2e_check( 'its @id is <home>/#organization (the entity the page already had, not a new one)', ( trailingslashit( home_url() ) . '#organization' ) === ( $o['@id'] ?? '' ), (string) ( $o['@id'] ?? '' ) );
				odito_e2e_check( 'its name is untouched by the address write', 'Eye Hospital Test Site' === ( $o['name'] ?? '' ), (string) ( $o['name'] ?? '' ) );
				if ( $local_seo_expected ) {
					odito_e2e_check( 'Rank Math publishes the address on that entity', isset( $o['address'] ) && is_array( $o['address'] ), json_encode( array_keys( $o ) ) );
					$a = $o['address'] ?? array();
					odito_e2e_check( 'as a PostalAddress', 'PostalAddress' === ( $a['@type'] ?? '' ), json_encode( $a ) );
					foreach ( ODITO_E2E_ADDRESS as $k => $v ) {
						odito_e2e_check( "with the exact $k the Bridge wrote", ( $a[ $k ] ?? null ) === $v, json_encode( $a[ $k ] ?? null ) );
					}
					echo '  entity: ' . json_encode( array_intersect_key( $o, array_flip( array( '@type', '@id', 'name', 'url', 'address' ) ) ) ) . "\n";
				} else {
					odito_e2e_check( 'Local SEO is OFF: the stored address is NOT published (this is why the Bridge reports localSeoActive and the planner holds the address back)', ! isset( $o['address'] ), json_encode( $o['address'] ?? null ) );
				}
			}
		} catch ( \Throwable $e ) {
			odito_e2e_check( 'no unexpected exception', false, $e->getMessage() );
		} finally {
			if ( is_array( $snapshot ) ) {
				unset( $snapshot['__expect_local_seo'] );
				odito_e2e_restore( $snapshot );
				@unlink( $snapshot_file );
				echo "restored the Rank Math options to their previous values\n";
			}
		}
		odito_e2e_finish();
	}

	$snapshot = array( $opt_titles => get_option( $opt_titles, null ), $opt_general => get_option( $opt_general, null ), $opt_modules => get_option( $opt_modules, null ) );
	$keep     = false;

	try {
		wp_set_current_user( 1 );

		if ( 'prepare' === $phase ) {
			$local_seo_on                  = 'off' !== getenv( 'ODITO_E2E_LOCAL_SEO' );
			$snapshot['__expect_local_seo'] = $local_seo_on ? 'on' : 'off';
			file_put_contents( $snapshot_file, json_encode( $snapshot ) );
			$keep    = true;
			$modules = array_values( array_diff( (array) get_option( $opt_modules, array() ), array( 'local-seo' ) ) );
			if ( $local_seo_on ) {
				$modules[] = 'local-seo';
			}
			update_option( $opt_modules, array_values( array_unique( $modules ) ) );
			odito_e2e_check( 'Local SEO is ' . ( $local_seo_on ? 'ON' : 'OFF' ) . ' as requested', $local_seo_on === ( true === ( odito_e2e_site()['localSeoActive'] ?? null ) ) );
			$titles                        = (array) get_option( $opt_titles, array() );
			$titles['knowledgegraph_type'] = 'company';
			$titles['knowledgegraph_name'] = 'Eye Hospital Test Site';
			$titles['local_business_type'] = 'Organization';
			$titles['local_address']       = array();
			update_option( $opt_titles, $titles );
			list( $code, $data ) = odito_e2e_put( 'address', $json( ODITO_E2E_ADDRESS ), array( 'expected' => '' ) );
			odito_e2e_check( 'the Bridge wrote the address through its REST route (the real write path)', 200 === $code, "$code " . json_encode( $data ) );
			odito_e2e_check( 'and reads it back', ODITO_E2E_ADDRESS === ( odito_e2e_site()['address'] ?? null ) );
			echo "left in place for the render phase\n";
			odito_e2e_finish();
		}

		echo "status\n";
		list( $code, $status ) = odito_e2e_call( 'GET', '/status' );
		odito_e2e_check( 'Bridge version is 1.6.0 or newer', 200 === $code && version_compare( (string) $status['bridge_version'], '1.6.0', '>=' ), (string) ( $status['bridge_version'] ?? '' ) );
		odito_e2e_check( 'supports.organization_address is true', ! empty( $status['supports']['organization_address'] ) );
		odito_e2e_check( 'supports.conditional_writes is still true', ! empty( $status['supports']['conditional_writes'] ) );

		$titles                           = (array) get_option( $opt_titles, array() );
		$titles['knowledgegraph_type']    = 'company';
		$titles['knowledgegraph_name']    = 'Eye Hospital Test Site';
		$titles['local_business_type']    = 'Organization';
		$titles['local_address']          = array();
		update_option( $opt_titles, $titles );

		echo "read\n";
		$org = odito_e2e_site();
		odito_e2e_check( 'address is an empty object when unset', array() === ( $org['address'] ?? null ), json_encode( $org['address'] ?? null ) );
		odito_e2e_check( 'hasAddress is false', false === ( $org['hasAddress'] ?? null ) );

		echo "write (compare-and-set against the empty value)\n";
		list( $code, $data ) = odito_e2e_put( 'address', $json( ODITO_E2E_ADDRESS ), array( 'expected' => '' ) );
		odito_e2e_check( 'the address is written', 200 === $code, "$code " . json_encode( $data ) );
		odito_e2e_check( 'the response reports an atomic operation', ! empty( $data['operation']['atomic'] ) && 'address' === ( $data['operation']['field'] ?? '' ), json_encode( $data['operation'] ?? null ) );
		$stored = (array) get_option( $opt_titles, array() );
		odito_e2e_check( 'local_address holds exactly the five fields, as written', ODITO_E2E_ADDRESS === ( $stored['local_address'] ?? null ), json_encode( $stored['local_address'] ?? null ) );
		odito_e2e_check( 'other Rank Math settings in the same row are untouched', 'Eye Hospital Test Site' === ( $stored['knowledgegraph_name'] ?? '' ) && 'company' === ( $stored['knowledgegraph_type'] ?? '' ) );
		$org = odito_e2e_site();
		odito_e2e_check( 'GET returns the structured address and hasAddress true', ODITO_E2E_ADDRESS === $org['address'] && true === $org['hasAddress'] );

		echo "stale expected value is refused\n";
		list( $code, $data ) = odito_e2e_put( 'address', $json( array_merge( ODITO_E2E_ADDRESS, array( 'streetAddress' => '99 Other Road' ) ) ), array( 'expected' => '' ) );
		odito_e2e_check( '409 odito_conflict (expected "no address", but one is stored)', 409 === $code && 'odito_conflict' === ( $data['code'] ?? '' ), "$code " . json_encode( $data ) );
		odito_e2e_check( 'the stored address is untouched', ODITO_E2E_ADDRESS === odito_e2e_site()['address'] );
		list( $code ) = odito_e2e_put( 'address', $json( array_merge( ODITO_E2E_ADDRESS, array( 'streetAddress' => '99 Other Road' ) ) ), array( 'expected' => $json( array( 'streetAddress' => 'somebody else' , 'addressLocality' => 'Elsewhere' ) ) ) );
		odito_e2e_check( 'a wrong expected address is also a 409', 409 === $code, (string) $code );
		list( $code ) = odito_e2e_put( 'address', $json( array_merge( ODITO_E2E_ADDRESS, array( 'postalCode' => '560002' ) ) ), array( 'expected' => $json( ODITO_E2E_ADDRESS ) ) );
		odito_e2e_check( 'the right expected address allows the change', 200 === $code && '560002' === odito_e2e_site()['address']['postalCode'] );
		odito_e2e_put( 'address', $json( ODITO_E2E_ADDRESS ), array( 'expected' => $json( array_merge( ODITO_E2E_ADDRESS, array( 'postalCode' => '560002' ) ) ) ) );

		echo "a partial address is completed only against what is stored\n";
		$titles                  = (array) get_option( $opt_titles, array() );
		$titles['local_address'] = array( 'addressLocality' => 'Rivertown', 'addressCountry' => 'IN' );
		update_option( $opt_titles, $titles );
		list( $code ) = odito_e2e_put( 'address', $json( ODITO_E2E_ADDRESS ), array( 'expected' => $json( array( 'addressLocality' => 'Rivertown', 'addressCountry' => 'IN' ) ) ) );
		odito_e2e_check( 'completing the stored partial address works', 200 === $code && ODITO_E2E_ADDRESS === odito_e2e_site()['address'] );

		echo "validation (nothing unsafe or incomplete is stored)\n";
		$before = (array) get_option( $opt_titles, array() );
		$bad    = array(
			'no city'                      => array( 'streetAddress' => '14 Lakeview Road' ),
			'no street'                    => array( 'addressLocality' => 'Rivertown' ),
			'an unknown key (geo)'         => array_merge( ODITO_E2E_ADDRESS, array( 'geo' => '1,2' ) ),
			'an unknown key (@type)'       => array_merge( ODITO_E2E_ADDRESS, array( '@type' => 'PostalAddress' ) ),
			'markup in the street'         => array_merge( ODITO_E2E_ADDRESS, array( 'streetAddress' => '<script>alert(1)</script>' ) ),
			'a nested value'               => array_merge( ODITO_E2E_ADDRESS, array( 'addressRegion' => array( 'Karnataka' ) ) ),
			'a control character'          => array_merge( ODITO_E2E_ADDRESS, array( 'streetAddress' => "14 Lake\x07view" ) ),
			'an over-long postal code'     => array_merge( ODITO_E2E_ADDRESS, array( 'postalCode' => str_repeat( '1', 21 ) ) ),
			'an over-long street'          => array_merge( ODITO_E2E_ADDRESS, array( 'streetAddress' => str_repeat( 'a', 201 ) ) ),
		);
		foreach ( $bad as $label => $address ) {
			list( $code ) = odito_e2e_put( 'address', $json( $address ), array( 'expected' => $json( ODITO_E2E_ADDRESS ) ) );
			odito_e2e_check( "$label is refused with 400", 400 === $code, (string) $code );
		}
		list( $code ) = odito_e2e_put( 'address', 'not json', array( 'expected' => $json( ODITO_E2E_ADDRESS ) ) );
		odito_e2e_check( 'a non-JSON value is refused with 400', 400 === $code, (string) $code );
		list( $code ) = odito_e2e_put( 'address', $json( array( 'a', 'list' ) ), array( 'expected' => $json( ODITO_E2E_ADDRESS ) ) );
		odito_e2e_check( 'a JSON list (not an object) is refused with 400', 400 === $code, (string) $code );
		list( $code ) = odito_e2e_put( 'address', '', array( 'expected' => $json( ODITO_E2E_ADDRESS ) ) );
		odito_e2e_check( 'an empty value is refused (clearing is only op "clear")', 400 === $code, (string) $code );
		odito_e2e_check( 'every refusal left the option row exactly as it was', $before === (array) get_option( $opt_titles, array() ) );

		echo "text is stored as typed, not mangled\n";
		$tricky = array_merge( ODITO_E2E_ADDRESS, array( 'streetAddress' => "St. Mary's Road & 5th Cross" ) );
		list( $code ) = odito_e2e_put( 'address', $json( $tricky ), array( 'expected' => $json( ODITO_E2E_ADDRESS ) ) );
		odito_e2e_check( 'an apostrophe and an ampersand survive', 200 === $code && "St. Mary's Road & 5th Cross" === odito_e2e_site()['address']['streetAddress'], json_encode( odito_e2e_site()['address'] ?? null ) );
		odito_e2e_put( 'address', $json( ODITO_E2E_ADDRESS ), array( 'expected' => $json( $tricky ) ) );

		echo "clear (the rollback primitive)\n";
		list( $code ) = odito_e2e_call( 'PUT', '/seo/site', array( 'entity' => 'organization', 'field' => 'address', 'op' => 'clear' ) );
		odito_e2e_check( 'clear without expected is refused', 400 === $code, (string) $code );
		list( $code ) = odito_e2e_call( 'PUT', '/seo/site', array( 'entity' => 'organization', 'field' => 'address', 'op' => 'clear', 'expected' => $json( array( 'streetAddress' => 'x', 'addressLocality' => 'y' ) ) ) );
		odito_e2e_check( 'clear with a wrong expected address is a 409 and changes nothing', 409 === $code && ODITO_E2E_ADDRESS === odito_e2e_site()['address'], (string) $code );
		list( $code ) = odito_e2e_call( 'PUT', '/seo/site', array( 'entity' => 'organization', 'field' => 'address', 'op' => 'clear', 'expected' => $json( ODITO_E2E_ADDRESS ) ) );
		odito_e2e_check( 'clear with the right expected address restores "no address"', 200 === $code && array() === odito_e2e_site()['address'] && false === odito_e2e_site()['hasAddress'] );
		$stored = (array) get_option( $opt_titles, array() );
		odito_e2e_check( 'and the rest of the settings row is untouched', 'Eye Hospital Test Site' === ( $stored['knowledgegraph_name'] ?? '' ) );

		echo "a person site publishes no Organization, so the write is refused\n";
		$titles                        = (array) get_option( $opt_titles, array() );
		$titles['knowledgegraph_type'] = 'person';
		update_option( $opt_titles, $titles );
		list( $code, $data ) = odito_e2e_put( 'address', $json( ODITO_E2E_ADDRESS ), array( 'expected' => '' ) );
		odito_e2e_check( 'refused (not silently ignored)', 500 === $code && false !== strpos( (string) ( $data['message'] ?? '' ), 'person' ), "$code " . json_encode( $data ) );
		odito_e2e_check( 'nothing stored', array() === odito_e2e_site()['address'] );
		$titles['knowledgegraph_type'] = 'company';
		update_option( $opt_titles, $titles );

		echo "permissions\n";
		wp_set_current_user( 2 );
		list( $code ) = odito_e2e_put( 'address', $json( ODITO_E2E_ADDRESS ), array( 'expected' => '' ) );
		odito_e2e_check( 'a user without manage_options gets 403', 403 === $code, (string) $code );
		wp_set_current_user( 0 );
		list( $code ) = odito_e2e_put( 'address', $json( ODITO_E2E_ADDRESS ), array( 'expected' => '' ) );
		odito_e2e_check( 'an unauthenticated request gets 401', 401 === $code, (string) $code );
		wp_set_current_user( 1 );
		odito_e2e_check( 'neither attempt changed anything', array() === odito_e2e_site()['address'] );

		echo "other fields keep their contract\n";
		list( $code ) = odito_e2e_put( 'name', 'Eye Hospital Test Site', array( 'expected' => 'Eye Hospital Test Site' ) );
		odito_e2e_check( 'a scalar organization write with expected still works', 200 === $code );
		list( $code ) = odito_e2e_put( 'logo', 'not a url', array( 'expected' => '' ) );
		odito_e2e_check( 'URL validation for the logo is unchanged (400)', 400 === $code, (string) $code );
	} catch ( \Throwable $e ) {
		odito_e2e_check( 'no unexpected exception', false, $e->getMessage() );
	} finally {
		if ( ! $keep ) {
			odito_e2e_restore( $snapshot );
			echo "\nrestored the Rank Math options to their previous values\n";
		}
	}

	odito_e2e_finish();
}

odito_e2e_run( getenv( 'ODITO_E2E_PHASE' ) ? getenv( 'ODITO_E2E_PHASE' ) : 'checks' );
