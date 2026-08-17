# Contributing to openSave

Thanks for helping make offline web capture more reproducible.

## Before You Start

- Work only with sites and content you own or are authorized to archive.
- Keep captures safe: never introduce code that submits forms, pays, deletes data, logs users out, or follows external links during automatic exploration.
- Preserve the extension's core guarantee: exported archives must not silently fall back to live production APIs.

## Development Setup

1. Clone the repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked** and select this repository folder.
5. After editing extension files, click Reload on the openSave card.

The project has no build step. `background.js`, `sidepanel.js`, and `sidepanel.html` are loaded directly by Chrome.

## Validation

Run static checks before opening a pull request:

```powershell
node --check background.js
node --check sidepanel.js
node tests/golden-capture.mjs tests/fixtures/offline-archive
node tests/browser-integration.mjs tests/fixtures/offline-archive
```

The browser integration check uses a local headless Chrome instance. It verifies service-worker control, SPA navigation, console/runtime errors, and external network requests.

## Capture Principles

- Prefer the smallest change that improves resource completeness.
- Keep Quick mode fast and predictable.
- Keep Deep mode conservative around interactive elements.
- Never add per-site behavior. Generic protocol/framework detection is acceptable; host-specific workarounds are not.
- Report missing resources instead of hiding failures.

## Pull Requests

Include:

- What changed and why.
- Which capture mode is affected.
- A capture report or fixture showing the behavior.
- Any new limitation or trade-off.

## Reporting Security Issues

Do not open public issues for security-sensitive findings. See `SECURITY.md`.
