import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

assert.match(panel, /archive-validator\.js/, 'Side panel must load the validator core');
assert.match(source, /async function validateArchive/, 'Generated artifacts must run post-export validation');
assert.match(source, /Fetch\.enable/, 'In-extension validation must intercept requests instead of allowing network access');
assert.match(source, /external-request-attempt/, 'External request attempts must be typed diagnostics');
assert.match(source, /opensaveValidationMarker/, 'Routes must be checked against their own captured content marker');
assert.match(source, /activeValidation\.cancelled = true/, 'Validation must support cooperative cancellation');
assert.match(source, /validation-report\.json/, 'Machine-readable validation results must be included in archives');
assert.match(source, /archive-validator-companion\.mjs/, 'Browser service-worker restrictions must produce a real local companion, not fake success');
assert.match(source, /validation\.status === 'ready'/, 'Side-panel results must distinguish ready from partial and failed');

console.log('PASS: post-export validator mount, markers, cancellation, result schema, and companion wiring');
