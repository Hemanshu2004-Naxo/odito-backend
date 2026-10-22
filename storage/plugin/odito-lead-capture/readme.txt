=== Odito Lead Capture ===
Contributors: odito
Tags: leads, forms, contact form 7, divi, integration
Requires at least: 5.6
Tested up to: 7.0
Requires PHP: 7.4
Stable tag: 1.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Securely connects your WordPress website to your Odito project and detects your contact forms.

== Description ==

Odito Lead Capture links this WordPress site to your Odito project using a
one-time pairing token generated from your Odito dashboard — no WordPress
password or Application Password is ever shared with the plugin itself.

Once connected, the plugin detects the structure of forms on your site —
Contact Form 7, Divi Builder contact forms, and generic HTML forms — and
synchronizes their field names and types with Odito. For Contact Form 7
specifically, a real form submission is also sent to Odito as a lead, once
the form has passed Contact Form 7's own validation. Sensitive-looking
fields (passwords, card numbers, security tokens, CF7's own internal
fields) are always excluded — only name/email/phone/message-type data is
sent. If Odito is temporarily unreachable, the submission is queued and
retried in the background; your form always continues to work normally
either way.

= What this plugin does =

* Pairs this site with an Odito project using a short-lived, one-time token
* Detects Contact Form 7, Divi contact forms, and generic HTML forms
* Synchronizes form structure (field names/types only) with Odito
* Captures real Contact Form 7 submissions as Odito leads, with sensitive fields always excluded
* Queues and retries submissions in the background if Odito is briefly unreachable — never blocks or breaks your form
* Sends a periodic heartbeat so Odito can show connection status

= What this plugin does NOT do (yet) =

* It does not capture submissions for Divi or generic HTML forms — only Contact Form 7 (see FAQ)
* It does not modify, disable, or delete your forms or content
* It does not install or manage other plugins
* It does not track site visitors

== Installation ==

1. Upload the plugin files to `/wp-content/plugins/odito-lead-capture`, or install via Plugins > Add New > Upload Plugin.
2. Activate the plugin through the 'Plugins' screen in WordPress.
3. In your Odito dashboard, generate a pairing token for this project.
4. Go to Settings > Odito, paste the pairing token, and click Connect.

== Frequently Asked Questions ==

= Does this plugin need my WordPress password? =

No. Pairing uses a one-time token you generate in your Odito dashboard.
The plugin never sees your WordPress login password or an Application
Password.

= What data does this plugin send to Odito? =

Your site's URL, WordPress/plugin version numbers, the structure of
detected forms (field names and types), and — for Contact Form 7 only —
the actual values of a real submission once it passes Contact Form 7's own
validation. Fields that look like passwords, payment details, or security
tokens are always excluded, regardless of form type.

= Why only Contact Form 7 for submission capture? =

Contact Form 7 provides a stable, public, well-documented hook for
reading a validated submission before it's mailed. Divi's contact form
does not currently expose an equivalent public server-side hook, and
generic HTML forms have no reliable, safe interception point (they may
submit via AJAX, to a custom handler, or off-site). Rather than guess at
an undocumented internal hook or scrape form-submit events unreliably,
submission capture is scoped to Contact Form 7 until a safe integration
point exists for the others.

== Changelog ==

= 1.2.0 =
* Retry queue entries are now encrypted at rest.
* Retry queue processing is now safe under concurrent WP-Cron runs (no duplicate submissions).
* Added a distinct status for forms that were previously synced but are no longer found on your site, so stale forms are clearly identified rather than silently accepted.
* Added pending/failed submission counts to the plugin's settings page for at-a-glance diagnostics.

= 1.1.0 =
* Added Contact Form 7 submission capture — a real form submission now becomes an Odito lead.
* Added a local retry queue (custom database table) so a temporarily unreachable Odito never blocks or breaks a customer's form.
* Sensitive-field filtering extended to submission values, not just field structure.

= 1.0.0 =
* Initial release: pairing, connection status, and form structure detection (Contact Form 7, Divi, generic HTML).
