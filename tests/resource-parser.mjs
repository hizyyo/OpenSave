import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Parser = require('../resource-parser.js');
const fixture = (name) => readFileSync(new URL(`fixtures/resource-parser/${name}`, import.meta.url), 'utf8');
const baseUrl = 'https://example.test/app/page.html';
const resources = new Map([
  ['https://example.test/css/main%20(v1).css?theme=dark', '/assets/main.css'],
  ['https://example.test/app/images/a%20(1x).png', '/assets/a-1x.png'],
  ['https://example.test/app/images/a%20%C3%BC@2x.png', '/assets/a-2x.png'],
  ['https://example.test/app/images/hero%20%C3%BC.png?x=1', '/assets/hero.png'],
  ['https://example.test/app/images/lazy%20image.png', '/assets/lazy.png'],
  ['https://example.test/app/images/wide%20(2x).png?size=2', '/assets/wide.png'],
  ['https://example.test/icons/sprite.svg', '/assets/sprite.svg'],
  ['https://example.test/fx/filters.svg', '/assets/filters.svg'],
  ['https://example.test/modules/main.js?x=1', '/assets/main.js'],
  ['https://example.test/app/nested%20theme.css', '/assets/theme.css'],
  ['https://example.test/fonts/open%20save.woff2?', '/assets/open-save.woff2'],
  ['https://example.test/images/hero(wide).png?size=2', '/assets/hero-wide.png'],
  ['https://example.test/images/photo%20(1x).png', '/assets/photo-1x.png'],
  ['https://example.test/images/photo%20%C3%BC@2x.png', '/assets/photo-2x.png'],
  ['https://example.test/app/images/cover%20%C3%BC.png?size=2', '/assets/cover.png'],
  ['https://example.test/app/images/fallback.png', '/assets/fallback.png'],
  ['https://example.test/app/icons.svg', '/assets/icons.svg'],
  ['https://example.test/app/effects.svg', '/assets/effects.svg'],
  ['https://example.test/app/masks.svg', '/assets/masks.svg'],
  ['https://example.test/app/paints.svg', '/assets/paints.svg'],
  ['https://example.test/app/modules/main.js?mode=static', '/assets/main.js'],
  ['https://example.test/shared/helper.js', '/assets/helper.js'],
  ['https://example.test/app/modules/lazy%20(view).js?lang=%E6%97%A5%E6%9C%AC%E8%AA%9E', '/assets/lazy.js'],
  ['https://example.test/app/query.png?a=1&b=2', '/assets/query.png'],
  ['https://cdn.example.test/icons/chrome.png', '/assets/chrome.png'],
  ['https://example.test/final.js', '/assets/redirected.js']
]);
const resolver = Parser.createResolver({
  resources,
  aliases: new Map([['https://cdn.example.test/alias.js', 'https://example.test/final.js']]),
  redirects: new Map([['https://example.test/redirect.js', 'https://cdn.example.test/alias.js']])
});

const discoveryCases = [
  {
    name: 'HTML URL and lazy attributes',
    discover: () => Parser.discoverHtmlReferences('<img src="a b.png" data-src="lazy.png"><script src="app.js"></script>', { baseUrl, ownerArtifact: 'body-1' }),
    kinds: ['html-url-attribute', 'html-lazy-attribute', 'html-url-attribute'],
    roles: ['image', 'image', 'script']
  },
  {
    name: 'srcset candidates preserve data URL commas',
    discover: () => Parser.discoverSrcsetReferences('data:image/png;base64,AAAA 1x, ./wide%20image.png 2x', { baseUrl, ownerArtifact: 'body-2' }),
    rawValues: ['data:image/png;base64,AAAA', './wide%20image.png']
  },
  {
    name: 'CSS import, font, URL, and image-set',
    discover: () => Parser.discoverCssReferences(fixture('css.input.css'), { baseUrl, ownerArtifact: 'body-3' }),
    kinds: ['css-import', 'css-url', 'css-url', 'css-image-set', 'css-image-set', 'css-url', 'css-url'],
    roles: ['css-import', 'font', 'image', 'image', 'image', 'image', 'image']
  },
  {
    name: 'SVG href, xlink, filter, mask, and paint',
    discover: () => Parser.discoverSvgReferences(fixture('svg.input.svg'), { baseUrl, ownerArtifact: 'body-4' }),
    kinds: ['svg-href', 'svg-xlink:href', 'svg-href', 'svg-filter', 'svg-mask', 'svg-fill', 'svg-stroke']
  },
  {
    name: 'JavaScript static module specifiers only',
    discover: () => Parser.discoverJavaScriptReferences(fixture('javascript.input.js'), { baseUrl, ownerArtifact: 'body-5' }),
    kinds: ['javascript-import-from', 'javascript-export-from', 'javascript-dynamic-import']
  }
];

for (const testCase of discoveryCases) {
  const references = testCase.discover();
  if (testCase.kinds) assert.deepEqual(references.map((reference) => reference.syntaxKind), testCase.kinds, testCase.name);
  if (testCase.roles) assert.deepEqual(references.map((reference) => reference.role), testCase.roles, testCase.name);
  if (testCase.rawValues) assert.deepEqual(references.map((reference) => reference.rawValue), testCase.rawValues, testCase.name);
  for (const reference of references) {
    assert.equal(reference.ownerArtifact.startsWith('body-'), true, `${testCase.name}: owner artifact`);
    assert.equal(typeof reference.rawValue, 'string', `${testCase.name}: raw value`);
    assert.equal(typeof reference.location, 'object', `${testCase.name}: location`);
    assert.equal(typeof reference.rewritePolicy, 'string', `${testCase.name}: rewrite policy`);
  }
}

const goldenCases = [
  ['HTML', 'html.input.html', 'html.golden.html', Parser.rewriteHtml],
  ['CSS', 'css.input.css', 'css.golden.css', Parser.rewriteCss],
  ['SVG', 'svg.input.svg', 'svg.golden.svg', Parser.rewriteSvg],
  ['JavaScript', 'javascript.input.js', 'javascript.golden.js', Parser.rewriteJavaScript]
];

for (const [name, inputName, goldenName, rewrite] of goldenCases) {
  const result = rewrite(fixture(inputName), { baseUrl, resolver });
  assert.equal(result.source, fixture(goldenName), `${name} golden output`);
}

const ordinaryJavaScript = 'const ui = "./modules/main.js?mode=display"; const origin = "https://example.test/app/";';
assert.equal(Parser.rewriteJavaScript(ordinaryJavaScript, { baseUrl, resolver }).source, ordinaryJavaScript, 'ordinary JavaScript strings must remain byte-identical');

const schemes = Parser.rewriteHtml('<img src="data:image/png;base64,AAAA"><img src="blob:https://example.test/id"><use href="#local"></use>', { baseUrl, resolver });
assert.equal(schemes.source, '<img src="data:image/png;base64,AAAA"><img src="blob:https://example.test/id"><use href="#local"></use>');
assert.equal(Parser.rewriteHtml('<script>import("./modules/main.js?mode=static")</script>', { baseUrl, resolver }).source, '<script>import("/assets/main.js")</script>', 'classic inline scripts must rewrite static dynamic imports');
assert.equal(Parser.rewriteHtml('<script>const s = document.createElement("script"); s.src = "./modules/main.js?mode=static";</script>', { baseUrl, resolver }).source, '<script>const s = document.createElement("script"); s.src = "/assets/main.js";</script>', 'dynamic script src assignments must use saved files');
assert.equal(Parser.rewriteHtml('<script>s.src = "https://example.test/modules/main.js?x=" + id;</script>', { baseUrl, resolver }).source, '<script>s.src = "https://example.test/modules/main.js?x=" + id;</script>', 'concatenated runtime URLs must not be treated as static assignments');
assert.equal(Parser.rewriteJavaScript('const icons = { chrome: "https://cdn.example.test/icons/chrome.png" };', { baseUrl, resolver }).source, 'const icons = { chrome: "/assets/chrome.png" };', 'captured static asset URLs in runtime maps must be localized');
assert.equal(Parser.rewriteJavaScript('const icon = "https://uncaptured.example.test/icon.png";', { baseUrl, resolver }).source, 'const icon = "https://uncaptured.example.test/icon.png";', 'uncaptured runtime asset URLs must remain intact');
assert.equal(Parser.rewriteHtml('<img src="query.png?a=1&amp;b=2">', { baseUrl, resolver }).source, '<img src="/assets/query.png">', 'HTML entities must be decoded before URL resolution');

const redirected = Parser.rewriteJavaScript('import "https://example.test/redirect.js";', { baseUrl, resolver });
assert.equal(redirected.source, 'import "/assets/redirected.js";');

const unresolved = Parser.rewriteJavaScript('import "./missing.js"; const value = "./missing.js";', { baseUrl, resolver });
assert.equal(unresolved.source, 'import "data:text/javascript,export%20{}"; const value = "./missing.js";');
assert.equal(unresolved.references[0].reasonCode, 'unresolved-executable');
assert.equal(unresolved.diagnostics[0].severity, 'error');

assert.throws(() => Parser.discoverCssReferences('a { background: url("broken.png) }', { baseUrl }), /Unterminated CSS string/);
const unaffected = Parser.rewriteJavaScript('import "./modules/main.js?mode=static#entry";', { baseUrl, resolver });
assert.equal(unaffected.source, 'import "/assets/main.js#entry";', 'one parser adapter failure must not poison another adapter');

console.log('PASS: typed resource discovery, resolver policy, and golden rewrites');
