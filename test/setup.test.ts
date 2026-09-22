import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SetupService } from '../src/ui/setup.js';
import { CredentialStore } from '../src/storage.js';

test('setup signs in, discovers devices and keeps secrets out of responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'airplus-setup-'));
  try {
    const replies = [
      { errorCode: 0, vToken: 'synthetic-otp-token' },
      { errorCode: 0, UID: 'synthetic-uid' },
      { meta: { code: 0 }, data: { timestamp1: 123 } },
      { meta: { code: 0 }, data: { token: 'synthetic-cloud-token' } },
      { meta: { code: 0 }, data: [{ device_id: 'synthetic-device', device_info: { modelid: 'HU1509/00', name: 'Humidifier' } }] },
    ];
    const store = new CredentialStore(directory);
    const service = new SetupService(store, async () => Response.json(replies.shift()));
    await service.handle('/auth/send', { email: 'test@example.com', signingSecret: 'synthetic-signing-key' });
    const response = JSON.stringify(await service.handle('/auth/verify', { code: '123456' }));
    assert.match(response, /synthetic-device/);
    for (const secret of ['synthetic-uid', 'synthetic-signing-key', 'synthetic-cloud-token', 'synthetic-otp-token']) assert.equal(response.includes(secret), false);
    assert.deepEqual(await service.handle('/status', {}), { authenticated: true });
    await service.handle('/auth/logout', {});
    assert.equal(await store.read(), undefined);
    await assert.rejects(service.handle('/devices', {}), /Sign in/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('device settings validate ownership and apply only the explicitly selected setting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'airplus-settings-'));
  try {
    const store = new CredentialStore(directory);
    await store.write({ uid: 'synthetic-uid', signingSecret: 'synthetic-signing-key' });
    let step = 0;
    const calls: unknown[] = [];
    const service = new SetupService(store, async () => {
      const responses = [{ meta: { code: 0 }, data: { timestamp1: 123 } }, { meta: { code: 0 }, data: { token: 'synthetic-token' } },
        { meta: { code: 0 }, data: [{ device_id: 'synthetic-device', device_info: { modelid: 'HU1509/00', name: 'Humidifier' } }] }];
      return Response.json(responses[step++ % 3]);
    }, () => ({ async run(id, patch) { calls.push({ id, patch }); return { timerHours: 4, beep: 1, standby: 0 }; } }));
    await service.handle('/device/apply', { deviceId: 'synthetic-device', timerHours: 4 });
    assert.deepEqual(calls, [{ id: 'synthetic-device', patch: { D03110: 5 } }]);
    await service.handle('/device/read', { deviceId: 'synthetic-device' });
    assert.deepEqual(calls.at(-1), { id: 'synthetic-device', patch: undefined });
    await assert.rejects(service.handle('/device/apply', { deviceId: 'synthetic-device', timerHours: 13 }), /Check/);
    await assert.rejects(service.handle('/device/apply', { deviceId: 'different-device', beep: true }), /Select a supported/);
    await assert.rejects(service.handle('/device/apply', { deviceId: 'synthetic-device', D03102: 0 }), /Check/);
    assert.equal(calls.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
