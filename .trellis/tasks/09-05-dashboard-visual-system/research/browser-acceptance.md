# Browser acceptance notes

Date: 2026-09-07

- Production same-origin runtime at http://127.0.0.1:18765/ loaded the revised shell with Projects, Progress, Workbench as the three primary buttons.
- Settings opens a labelled secondary dialog with AFK, Machine, and Host Plan; the close control, Escape handling, and visible focus were checked through the browser DOM.
- Machine deep view showed readiness first, with optional AFK sandbox and advanced/debug content below the primary readiness facts.
- Host Plan deep view showed the recommended Codex target, read-only plan preview, and no adapter installer component in the rendered page.
- At 375, 768, and 1440 viewport overrides, the checked routes reported no content wider than the viewport after accounting for the scrollbar. Host Plan and Overview remain intentionally long vertical pages and need future density work.
- Browser logs were checked after route navigation; no new unhandled console error was observed. Unit tests continue to emit existing React act warnings around asynchronous drawer/evidence surfaces.
