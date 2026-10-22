<?php
/**
 * Odito_Forms
 *
 * Form STRUCTURE detection only — field names and types, never a submitted
 * value (there is no submission hook anywhere in this file; Phase 3B adds
 * that separately). Three detectors, each independent:
 *
 *   - Contact Form 7: uses CF7's own public API (WPCF7_ContactForm::find(),
 *     scan_form_tags()) when the plugin is active — not shortcode scraping.
 *   - Divi: Divi has no equivalent "list all contact form modules" API, so
 *     this defensively parses the [et_pb_contact_form]/[et_pb_contact_field]
 *     shortcode syntax stored in post_content using WordPress's own
 *     shortcode_parse_atts() — attribute-based, not blind HTML scraping.
 *   - Generic: scans stored post_content for literal <form> markup (e.g. a
 *     Custom HTML block) via PHP's DOMDocument, a defensive HTML parser
 *     that tolerates malformed markup rather than a regex DOM scrape.
 *
 * CF7/Divi forms live in post_content as shortcode syntax, not rendered
 * HTML, so the generic detector naturally never double-counts them — no
 * separate dedup pass is needed.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Odito_Forms {

	const MAX_POSTS_SCANNED = 200;

	/** Runs all three detectors and returns one merged, normalized list. */
	public static function detect_forms() {
		$forms = array();

		$forms = array_merge( $forms, self::detect_contact_form_7() );
		$forms = array_merge( $forms, self::detect_divi() );
		$forms = array_merge( $forms, self::detect_generic() );

		return $forms;
	}

	public static function is_sensitive_field( $field_name ) {
		return Odito_Security::is_sensitive_field( $field_name );
	}

	// ── Contact Form 7 ────────────────────────────────────────────────────

	private static function detect_contact_form_7() {
		if ( ! class_exists( 'WPCF7_ContactForm' ) || ! method_exists( 'WPCF7_ContactForm', 'find' ) ) {
			return array();
		}

		$forms = array();

		foreach ( WPCF7_ContactForm::find() as $cf7_form ) {
			$fields = array();

			if ( method_exists( $cf7_form, 'scan_form_tags' ) ) {
				foreach ( $cf7_form->scan_form_tags() as $tag ) {
					$field_name = isset( $tag->name ) ? $tag->name : '';
					if ( empty( $field_name ) ) {
						continue;
					}
					if ( self::is_sensitive_field( $field_name ) ) {
						continue;
					}
					$basetype = isset( $tag->basetype ) ? $tag->basetype : 'text';
					if ( in_array( $basetype, array( 'submit', 'acceptance' ), true ) ) {
						continue;
					}
					$fields[] = array(
						'name' => $field_name,
						'type' => self::normalize_cf7_type( $basetype ),
					);
				}
			}

			$form_id = method_exists( $cf7_form, 'id' ) ? $cf7_form->id() : $cf7_form->id;
			$title   = method_exists( $cf7_form, 'title' ) ? $cf7_form->title() : '';

			$forms[] = array(
				'externalId' => 'cf7-' . $form_id,
				'provider'   => 'contact_form_7',
				'name'       => $title ? $title : ( 'Contact Form 7 #' . $form_id ),
				'pageUrl'    => self::find_page_url_containing( '[contact-form-7 id="' . $form_id . '"' ),
				'fields'     => $fields,
			);
		}

		return $forms;
	}

	private static function normalize_cf7_type( $basetype ) {
		$map = array(
			'text'       => 'text',
			'email'      => 'email',
			'tel'        => 'tel',
			'url'        => 'url',
			'number'     => 'number',
			'date'       => 'date',
			'textarea'   => 'textarea',
			'select'     => 'select',
			'checkbox'   => 'checkbox',
			'radio'      => 'radio',
			'quiz'       => 'text',
			'file'       => 'file',
		);
		return isset( $map[ $basetype ] ) ? $map[ $basetype ] : 'text';
	}

	// ── Divi ──────────────────────────────────────────────────────────────

	private static function is_divi_active() {
		if ( defined( 'ET_BUILDER_VERSION' ) ) {
			return true;
		}
		$theme = wp_get_theme();
		$template = strtolower( $theme->get_template() );
		return in_array( $template, array( 'divi', 'divi-builder', 'extra' ), true );
	}

	private static function detect_divi() {
		if ( ! self::is_divi_active() ) {
			return array();
		}

		$forms = array();

		foreach ( self::get_scannable_posts() as $post_id ) {
			$forms = array_merge( $forms, self::find_divi_forms_in_post( $post_id ) );
		}

		return $forms;
	}

	/**
	 * Parses the Divi contact-form shortcodes in ONE post's content and
	 * returns the same form-descriptor shape detect_divi() has always
	 * produced (externalId `divi-<post_id>-<index>`, `name`, `type` per
	 * field), plus an additive `raw_field_id` on each field (Divi's own
	 * `field_id` shortcode attribute, kept separately from the human-facing
	 * `name` even when `field_title` is what actually became `name`).
	 *
	 * Extracted out of detect_divi() (pure refactor, same regex/parsing,
	 * same output for the sync path) so Divi submission capture can resolve
	 * "which synced form did this submission come from" using the exact
	 * same parsing Odito already syncs — not a second, separately-maintained
	 * form-identification system.
	 */
	public static function find_divi_forms_in_post( $post_id ) {
		$content = get_post_field( 'post_content', $post_id );
		if ( empty( $content ) || false === strpos( $content, 'et_pb_contact_form' ) ) {
			return array();
		}

		$forms = array();

		$matches = array();
		preg_match_all(
			'/\[et_pb_contact_form\b([^\]]*)\](.*?)\[\/et_pb_contact_form\]/s',
			$content,
			$matches,
			PREG_SET_ORDER
		);

		foreach ( $matches as $index => $match ) {
			$container_atts = shortcode_parse_atts( $match[1] );
			$inner_content  = $match[2];

			$field_matches = array();
			preg_match_all( '/\[et_pb_contact_field\b([^\]]*)\]/', $inner_content, $field_matches );

			$fields = array();
			foreach ( $field_matches[1] as $field_atts_str ) {
				$field_atts = shortcode_parse_atts( $field_atts_str );

				$raw_field_id = is_array( $field_atts ) && ! empty( $field_atts['field_id'] ) ? $field_atts['field_id'] : '';

				$field_name = '';
				if ( is_array( $field_atts ) ) {
					if ( ! empty( $field_atts['field_title'] ) ) {
						$field_name = $field_atts['field_title'];
					} elseif ( ! empty( $field_atts['field_id'] ) ) {
						$field_name = $field_atts['field_id'];
					}
				}

				if ( empty( $field_name ) || self::is_sensitive_field( $field_name ) ) {
					continue;
				}

				$field_type = is_array( $field_atts ) && ! empty( $field_atts['field_type'] ) ? $field_atts['field_type'] : 'input';
				$fields[]   = array(
					'name'         => $field_name,
					'type'         => self::normalize_divi_field_type( $field_type ),
					'raw_field_id' => $raw_field_id,
				);
			}

			$title = is_array( $container_atts ) && ! empty( $container_atts['title'] ) ? $container_atts['title'] : get_the_title( $post_id );

			$forms[] = array(
				'externalId' => 'divi-' . $post_id . '-' . $index,
				'provider'   => 'divi',
				'name'       => $title ? $title : ( 'Divi Contact Form #' . $post_id . '-' . $index ),
				'pageUrl'    => get_permalink( $post_id ),
				'fields'     => $fields,
			);
		}

		return $forms;
	}

	private static function normalize_divi_field_type( $divi_type ) {
		$map = array(
			'input'    => 'text',
			'email'    => 'email',
			'text'     => 'textarea',
			'checkbox' => 'checkbox',
			'select'   => 'select',
			'radio'    => 'radio',
			'fullwidth_field' => 'textarea',
		);
		return isset( $map[ $divi_type ] ) ? $map[ $divi_type ] : 'text';
	}

	// ── Generic HTML forms ─────────────────────────────────────────────────

	private static function detect_generic() {
		$forms = array();

		foreach ( self::get_scannable_posts() as $post_id ) {
			$content = get_post_field( 'post_content', $post_id );
			if ( false === stripos( $content, '<form' ) ) {
				continue;
			}

			$dom = new DOMDocument();
			$previous_setting = libxml_use_internal_errors( true );
			// A dummy encoding declaration keeps DOMDocument from
			// mis-detecting UTF-8 content as Latin-1 — a well-known
			// DOMDocument quirk, not stripped from the actual output since
			// we only ever read the parsed tree, never re-serialize it.
			$dom->loadHTML( '<?xml encoding="utf-8" ?>' . $content );
			libxml_clear_errors();
			libxml_use_internal_errors( $previous_setting );

			$form_nodes = $dom->getElementsByTagName( 'form' );
			$index = 0;

			foreach ( $form_nodes as $form_node ) {
				$fields = self::extract_generic_fields( $form_node );

				$forms[] = array(
					'externalId' => 'generic-' . $post_id . '-' . $index,
					'provider'   => 'generic',
					'name'       => get_the_title( $post_id ),
					'pageUrl'    => get_permalink( $post_id ),
					'fields'     => $fields,
				);
				$index++;
			}
		}

		return $forms;
	}

	private static function extract_generic_fields( DOMElement $form_node ) {
		$fields = array();
		$skip_types = array( 'submit', 'button', 'hidden', 'password' );

		foreach ( array( 'input', 'textarea', 'select' ) as $tag_name ) {
			foreach ( $form_node->getElementsByTagName( $tag_name ) as $field_node ) {
				$field_type = 'input' === $tag_name
					? ( $field_node->getAttribute( 'type' ) ? $field_node->getAttribute( 'type' ) : 'text' )
					: $tag_name;

				if ( in_array( strtolower( $field_type ), $skip_types, true ) ) {
					continue;
				}

				$field_name = $field_node->getAttribute( 'name' );
				if ( empty( $field_name ) ) {
					continue;
				}
				if ( self::is_sensitive_field( $field_name ) ) {
					continue;
				}

				$fields[] = array(
					'name' => $field_name,
					'type' => $field_type,
				);
			}
		}

		return $fields;
	}

	// ── Shared helpers ────────────────────────────────────────────────────

	/** Published posts/pages only, capped — this is admin-triggered/cron-triggered, never per-visitor (Section 32). */
	private static function get_scannable_posts() {
		return get_posts(
			array(
				'post_type'      => array( 'post', 'page' ),
				'post_status'    => 'publish',
				'posts_per_page' => self::MAX_POSTS_SCANNED,
				'fields'         => 'ids',
				'no_found_rows'  => true,
			)
		);
	}

	private static function find_page_url_containing( $needle ) {
		$posts = get_posts(
			array(
				'post_type'      => array( 'post', 'page' ),
				'post_status'    => 'publish',
				'posts_per_page' => self::MAX_POSTS_SCANNED,
				's'              => $needle,
				'fields'         => 'ids',
				'no_found_rows'  => true,
			)
		);
		return ! empty( $posts ) ? get_permalink( $posts[0] ) : home_url();
	}
}
