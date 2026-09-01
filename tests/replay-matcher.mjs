import assert from 'node:assert/strict';
import ReplayMatcher from '../replay-matcher.js';

const hash = (body) => `sha256:${ReplayMatcher.sha256Hex(body)}`;
const records = [
  { exchangeId: 'poll-1', sequence: 1, method: 'GET', url: 'https://source.test/api/poll', contentType: '', requestBodyHash: hash(''), status: 200 },
  { exchangeId: 'poll-2', sequence: 2, method: 'GET', url: 'https://source.test/api/poll', contentType: '', requestBodyHash: hash(''), status: 200 },
  { exchangeId: 'post-1', sequence: 3, method: 'POST', url: 'https://source.test/api/post', contentType: 'application/json; charset=utf-8', requestBodyHash: hash('{"variant":"one"}'), status: 200 },
  { exchangeId: 'post-2', sequence: 4, method: 'POST', url: 'https://source.test/api/post', contentType: 'application/json', requestBodyHash: hash('{"variant":"two"}'), status: 200 }
];

const matcher = ReplayMatcher.createMatcher(records, { runtimeOrigin: 'https://replay.test' });
const pollIdentity = { method: 'GET', url: 'https://replay.test/api/poll', body: '', contentType: '' };
assert.equal(matcher.matchIdentity(pollIdentity).snapshot.exchangeId, 'poll-1');
assert.equal(matcher.matchIdentity(pollIdentity).snapshot.exchangeId, 'poll-2');
assert.equal(matcher.matchIdentity(pollIdentity).miss.reasonCode, 'repeat-exhausted');

assert.equal(matcher.matchIdentity({ method: 'POST', url: 'https://replay.test/api/post', body: '{"variant":"one"}', contentType: 'application/json; charset=UTF-8' }).snapshot.exchangeId, 'post-1');
assert.equal(matcher.matchIdentity({ method: 'POST', url: 'https://replay.test/api/post', body: '{"variant":"two"}', contentType: 'application/json' }).snapshot.exchangeId, 'post-2');
assert.equal(matcher.matchIdentity({ method: 'POST', url: 'https://replay.test/api/post', body: '{"variant":"missing"}', contentType: 'application/json' }).miss.reasonCode, 'not-found');

const ambiguous = ReplayMatcher.createMatcher([
  { sequence: 1, method: 'GET', url: 'https://one.test/shared', requestBodyHash: hash('') },
  { sequence: 2, method: 'GET', url: 'https://two.test/shared', requestBodyHash: hash('') }
], { runtimeOrigin: 'https://replay.test' });
assert.equal(ambiguous.matchIdentity({ method: 'GET', url: 'https://replay.test/shared', body: '' }).miss.reasonCode, 'ambiguous');
assert.equal(ambiguous.matchIdentity({ method: 'GET', url: 'https://one.test/shared', body: '' }).snapshot.url, 'https://one.test/shared');

assert.equal(ReplayMatcher.unsupportedReason({ method: 'PUT', headers: {} }), 'unknown-mutation');
assert.equal(ReplayMatcher.unsupportedReason({ method: 'GET', headers: { range: 'bytes=0-10' } }), 'range-request');
assert.equal(ReplayMatcher.unsupportedReason({ method: 'GET', headers: { accept: 'text/event-stream' } }), 'sse');
assert.equal(ReplayMatcher.unsupportedReason({ method: 'POST', destination: 'beacon', headers: {} }), 'beacon');
assert.equal(ReplayMatcher.unsupportedReason({ method: 'POST', headers: { 'content-type': 'application/octet-stream' } }), 'unsupported-post-content-type');
assert.equal(ReplayMatcher.unsupportedReason({ method: 'POST', contentType: 'application/octet-stream' }), 'unsupported-post-content-type');
assert.equal(ReplayMatcher.unsupportedReason({ method: 'GET', url: 'data:text/plain,offline' }), 'unsupported-url-scheme');
assert.equal(ReplayMatcher.unsupportedReason({ method: 'GET', url: 'not a valid URL' }), 'invalid-request-url');

console.log('PASS: exact replay identity, ordered repeats, ambiguity, and fail-closed reasons');
