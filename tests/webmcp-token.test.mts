import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test("the page carries Chrome's WebMCP origin-trial token for its own origin", () => {
  const html = fs.readFileSync('src/app/index.html', 'utf8');
  const token = /<meta http-equiv="origin-trial" content="([A-Za-z0-9+/=]+)">/.exec(html)?.[1];
  assert.ok(token, 'the meta tag is there');
  // A token: a version byte, a 64-byte signature, the payload's length (4 bytes, big-endian), then the payload as JSON.
  const bytes = Buffer.from(token, 'base64'), length = bytes.readUInt32BE(65);
  const payload = JSON.parse(bytes.subarray(69, 69 + length).toString('utf8')) as { origin: string; feature: string; expiry: number; isSubdomain?: boolean };
  assert.equal(payload.feature, 'WebMCP');
  // Since the move (2026-11-14) the page is served only at liquiditymapper.com; the token also covers www.liquiditymapper.com.
  assert.equal(payload.origin, 'https://liquiditymapper.com:443');
  assert.equal(payload.isSubdomain, true, 'www too');
  assert.ok(!('isThirdParty' in payload), 'never injected on other sites');
  assert.equal(payload.expiry, 1_806_364_800, 'the trial ends 2027-03-29: register again before then');
  assert.equal(html.match(/http-equiv="origin-trial"/g)?.length, 1, 'one token');
});
