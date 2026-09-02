# Archive Validation

openSave validates the generated artifact rather than source strings or only a repository fixture.

## Result Schema

`validation-report.json` uses schema version 1 and returns one terminal status:

- `ready`: all required files, route checkpoints, runtime checks, service-worker control, and zero-egress checks passed.
- `partial`: the artifact is usable but has capture/rewrite/replay warnings, exceeded a validation budget, or requires the local companion for the service-worker check.
- `failed`: a required file, route checkpoint, runtime, service-worker, or validator infrastructure check failed.
- `cancelled`: the user cancelled validation. The archive remains downloadable.

Diagnostics use `capture-miss`, `rewrite-failure`, `replay-runtime-failure`, or `validator-infrastructure` categories and always include a reason code. Informational optional requests do not lower a `ready` result.

## Automatic Runner

The side panel validates the completed in-memory ZIP before download. A hidden tab is attached through Chrome DevTools Protocol. Every request is intercepted and fulfilled only from the ZIP file map; external attempts receive a local 503 response and are recorded. Root and saved routes must execute their own injected checkpoint marker within bounded route and total time budgets.

Chrome does not expose a service-worker update fetch to the tab debugger. The automatic runner therefore returns `partial` with `local-companion-required` when all available checks pass but real service-worker control cannot be established. It does not fake `ready`.

## Local Companion

The ZIP includes `archive-validator-companion.mjs` plus Windows and Unix launchers. It starts a temporary loopback-only static server and an isolated headless Chrome profile, blocks external HTTP(S) requests through CDP, opens every planned route, verifies real service-worker control, reads replay misses, and writes the final result back into the unpacked archive.

The companion requires Node.js and Chrome or Chromium. `CHROME_PATH` can select a non-default browser executable.
