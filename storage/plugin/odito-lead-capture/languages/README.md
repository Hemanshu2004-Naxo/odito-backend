# Languages

All user-facing strings in this plugin are already wrapped in `__()` / `_e()` / `_n()` calls with the `odito-lead-capture` text domain (see `odito.php`'s `Text Domain`/`Domain Path` headers), so the plugin is translation-ready.

No `.pot` file is committed here yet — generating one is a build step (e.g. `wp i18n make-pot . languages/odito-lead-capture.pot`), not something to hand-author, and is left for when the plugin is actually published. See Known Limitations in the Phase 3A report.
