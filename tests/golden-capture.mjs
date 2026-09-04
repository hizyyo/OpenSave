import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const archivePath = process.argv[2];

if (!archivePath) {
  console.error('Usage: node tests/golden-capture.mjs <unpacked-sitesaver-archive>');
  process.exit(2);
}

const required = ['index.html', 'replay-matcher.js', 'replay-misses.json', 'sitesaver-offline.js', 'sitesaver-sw.js', 'sitesaver-report.json', 'sitesaver-manifest.json', 'README.txt', 'open-windows.bat', 'open-windows.ps1', 'open-unix.sh'];
const failures = [];

for (const filename of required) {
  if (!existsSync(join(archivePath, filename))) failures.push(`Missing ${filename}`);
}

if (!failures.length) {
  const html = readFileSync(join(archivePath, 'index.html'), 'utf8');
  const replay = readFileSync(join(archivePath, 'sitesaver-offline.js'), 'utf8');
  const worker = readFileSync(join(archivePath, 'sitesaver-sw.js'), 'utf8');
  const report = JSON.parse(readFileSync(join(archivePath, 'sitesaver-report.json'), 'utf8'));
  const replayMisses = JSON.parse(readFileSync(join(archivePath, 'replay-misses.json'), 'utf8'));

  if (/assets\/[^"']*index\.htmlassets/i.test(html)) failures.push('Corrupted root URL rewrite detected');
  if (/<script\b[^>]*\bsrc=["']https?:\/\//i.test(html)) failures.push('Remote executable script remains');
  if (/<link\b(?=[^>]*\brel=["'][^"']*stylesheet)[^>]*\bhref=["']https?:\/\//i.test(html)) failures.push('Remote stylesheet remains');
  if (!replay.includes("navigator.serviceWorker.register('/sitesaver-sw.js')")) failures.push('Offline bootstrap does not register the service worker');
  if (!worker.includes("reasonCode: 'external-network-blocked'")) failures.push('Service worker does not block external network');
  if (!worker.includes("request.mode === 'navigate'")) failures.push('Service worker is missing SPA navigation fallback');
  if (!worker.includes('PAGE_ROUTES')) failures.push('Service worker is missing captured-page route mapping');
  if (!worker.includes('OpenSaveReplayMatcher.createMatcher')) failures.push('Service worker is missing exact request matching');
  if (!Array.isArray(replayMisses.captureMisses) || !Array.isArray(replayMisses.runtimeMisses)) failures.push('Replay miss ledger is invalid');
  if (!report.completeness || typeof report.completeness.score !== 'number') failures.push('Completeness score is missing');
  const manifest = JSON.parse(readFileSync(join(archivePath, 'sitesaver-manifest.json'), 'utf8'));
  if (manifest.format !== 'sitesaver-offline-archive' || !manifest.sourceUrl) failures.push('Archive manifest is incomplete');
  if (manifest.version !== 2 && manifest.version !== 3) failures.push('Archive manifest version must be 2 or 3');
  if (existsSync(join(archivePath, 'package.json'))) failures.push('Archive must not require a Node.js package.json');

  const sourceDocument = join(archivePath, 'assets', new URL(report.pageUrl || 'https://example.invalid').hostname, 'index.html');
  if (existsSync(sourceDocument)) {
    const source = readFileSync(sourceDocument, 'utf8');
    if (/\$_TSR|tsr-stream-barrier/.test(source) && !/\$_TSR|tsr-stream-barrier/.test(html)) {
      failures.push('TanStack SSR hydration payload was not restored in root index.html');
    }
  }
}

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});

if (existsSync(archivePath)) {
  const files = walk(archivePath).filter((path) => statSync(path).isFile());
  if (files.length < 4) failures.push('Archive has too few files to be a complete capture');
  console.log(`Checked ${files.length} files in ${relative(process.cwd(), archivePath) || archivePath}`);
}

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL: ${failure}`));
  process.exit(1);
}

console.log('PASS: offline archive invariants hold');
