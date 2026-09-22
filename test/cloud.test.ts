import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cloud, EmailAuth, signature, type Fetcher } from '../src/cloud.js';
import { CredentialStore } from '../src/storage.js';
import { safeError } from '../src/errors.js';

function replies(values: unknown[]): Fetcher {
  return async () => Response.json(values.shift());
}

test('signature preserves form encoding including spaces, tilde and unicode', () => {
  assert.equal(signature('123', 'PHILIPS:a b~!*é', 'synthetic'), 'd641f800e3959397a55aecdc098c3af65ac71a1f98dadf803d1bff7b6d7519e7');
});

test('email verification rejects wrong and expired codes', async () => {
  let now = 0;
  const auth = new EmailAuth(replies([{ errorCode: 0, vToken: 'synthetic' }, { errorCode: 403 }]), () => now);
  await auth.send('test@example.com');
  await assert.rejects(auth.verify('123456'), /rejected/);
  now = 600001;
  await assert.rejects(auth.verify('123456'), /expired/);
});

test('cloud errors never expose upstream response or request details', async () => {
  const cloud = new Cloud({ uid: 'synthetic', signingSecret: 'synthetic' }, async () => { throw new Error('private-token-value'); });
  await assert.rejects(cloud.devices(), error => !safeError(error).includes('private-token-value'));
});

test('credential storage is private and removable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'airplus-test-'));
  try {
    const store = new CredentialStore(directory);
    assert.equal(await store.read(), undefined);
    await store.write({ uid: 'synthetic', signingSecret: 'synthetic' });
    assert.equal((await stat(join(store.directory, 'credentials.json'))).mode & 0o777, 0o600);
    assert.equal((await store.read())?.uid, 'synthetic');
    await store.clear();
    assert.equal(await store.read(), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
