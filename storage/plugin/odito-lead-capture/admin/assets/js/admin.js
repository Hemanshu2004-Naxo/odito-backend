/**
 * Odito Lead Capture — admin settings page.
 *
 * Deliberately minimal: this file only talks to WordPress's own admin
 * UI (a confirm dialog before submitting an existing admin-post.php form).
 * It never calls the Odito API directly from the browser — every request
 * to Odito is made server-side by WordPress (see includes/class-odito-api.php),
 * which is the whole point of a plugin-based integration over a browser
 * tracker script (see the Phase 3A architecture notes).
 */
( function () {
	'use strict';

	document.addEventListener( 'DOMContentLoaded', function () {
		var form = document.querySelector( '.odito-disconnect-form' );
		if ( ! form ) {
			return;
		}

		form.addEventListener( 'submit', function ( event ) {
			var button = form.querySelector( '.odito-disconnect-button' );
			var message = button ? button.getAttribute( 'data-confirm' ) : '';
			if ( message && ! window.confirm( message ) ) {
				event.preventDefault();
			}
		} );
	} );
} )();
