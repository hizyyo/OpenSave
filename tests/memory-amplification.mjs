import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const JSZip = require('../lib/jszip.min.js');
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PAYLOAD_BYTES = 16 * 1024 * 1024;

const retained = [];
const samples = [];
const memory = () => process.memoryUsage();
const sample = (stage, before) => {
  const after = memory();
  samples.push({
    stage,
    heapUsedDelta: after.heapUsed - before.heapUsed,
    externalDelta: after.external - before.external,
    arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
    rssDelta: after.rss - before.rss
  });
  return after;
};

let previous = memory();
const bytes = Buffer.alloc(PAYLOAD_BYTES, 0x61);
retained.push(bytes);
previous = sample('raw-buffer', previous);

const text = bytes.toString('utf8');
retained.push(text);
previous = sample('utf8-string', previous);

const base64 = bytes.toString('base64');
retained.push(base64);
previous = sample('base64-string', previous);

const blob = new Blob([bytes]);
retained.push(blob);
previous = sample('blob-conversion', previous);

const zip = new JSZip();
zip.file('payload.bin', base64, { base64: true });
const archive = await zip.generateAsync({ type: 'nodebuffer', streamFiles: true, compression: 'STORE' });
retained.push(zip, archive);
sample('jszip-generation', previous);

const result = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  payloadBytes: PAYLOAD_BYTES,
  theoretical: {
    base64Characters: base64.length,
    base64PayloadAmplification: base64.length / PAYLOAD_BYTES,
    simultaneousRawBase64AndArchiveBytes: PAYLOAD_BYTES + base64.length + archive.byteLength,
    simultaneousAmplification: (PAYLOAD_BYTES + base64.length + archive.byteLength) / PAYLOAD_BYTES
  },
  archiveBytes: archive.byteLength,
  samples
};

const artifactsDirectory = join(ROOT, 'tests', 'artifacts');
mkdirSync(artifactsDirectory, { recursive: true });
const output = join(artifactsDirectory, 'memory-amplification.json');
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
console.log(`PASS: memory amplification measurements written to ${output}`);
