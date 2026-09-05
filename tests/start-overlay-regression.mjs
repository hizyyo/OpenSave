import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const failures = [];

const activation = source.match(/async function activateStartOverlay\(tabId, maxDurationMs = 8000\) \{([\s\S]*?)\n\}/);
if (!activation) {
  failures.push('Deep capture has no start-overlay activation stage');
} else {
  const body = activation[1];
  if (!/\bstart\|begin\|enter\|launch\b/i.test(body)) failures.push('Start-overlay activation does not recognize startup labels');
  if (!/form, a\[href\], \[contenteditable="true"\]/.test(body)) failures.push('Start-overlay activation may click forms or links');
  if (!/element\.click\(\)/.test(body)) failures.push('Start-overlay activation does not trigger the candidate');
  if (!/waited < 8000/.test(body)) failures.push('Start-overlay activation does not wait for delayed loaders');
}

const activationIndex = source.indexOf('activateStartOverlay(tabId,');
const interactionIndex = source.indexOf('exploreInteractiveElements(tabId,');
if (activationIndex < 0 || interactionIndex < 0 || activationIndex > interactionIndex) {
  failures.push('Start-overlay activation must run before generic interactive exploration');
}

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL: ${failure}`));
  process.exit(1);
}

console.log('PASS: start-overlay activation regression contract holds');
