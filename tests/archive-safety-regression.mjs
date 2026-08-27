import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');
const failures = [];

if (!/\[integrity\][^\n]*removeAttribute\('integrity'\)/.test(source)) {
  failures.push('Localized documents do not remove stale SRI attributes');
}
if (!/Content-Security-Policy/.test(source) || !/connect-src \\'self\\'/.test(source)) {
  failures.push('Offline documents do not include a same-origin network policy');
}
if (!/data-srcset/.test(source) || !/data-src/.test(source)) {
  failures.push('Lazy data-src and data-srcset attributes are not rewritten');
}
if (!/quotedValue \|\| unquotedValue/.test(source)) {
  failures.push('CSS URL parsing does not preserve quoted paths with spaces');
}
if (!/document\.querySelectorAll\('script\[src\]'\)/.test(source) || !/scriptSources\.has\(source\)/.test(source)) {
  failures.push('Duplicate or external script sources are not filtered');
}
if (!/inlineScriptSources/.test(source) || !/\.src\\s\*=/.test(source)) {
  failures.push('Inline script-injected duplicate sources are not filtered');
}

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL: ${failure}`));
  process.exit(1);
}

console.log('PASS: archive rewrite and safety regression contract holds');
