import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const failures = [];
const functionsReturningObjects = [
  'replayScenario',
  'activateStartOverlay',
  'scrollForLazyResources',
  'exploreHoverStates',
  'captureCanvasFallback',
  'exploreInteractiveElements'
];

for (const name of functionsReturningObjects) {
  const start = source.indexOf(`async function ${name}(`);
  const next = start < 0 ? -1 : source.indexOf('\nasync function ', start + 1);
  const body = start < 0 ? '' : source.slice(start, next < 0 ? source.length : next);
  if (!body) failures.push(`Missing ${name}`);
  else if (!/returnByValue:\s*true/.test(body)) failures.push(`${name} does not serialize its Runtime.evaluate result`);
}

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL: ${failure}`));
  process.exit(1);
}

console.log('PASS: deep Runtime.evaluate results are returned by value');
