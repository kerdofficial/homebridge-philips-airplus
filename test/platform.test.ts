import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'homebridge';
import { HomebridgeAPI } from './homebridge.js';
import { PhilipsAirPlusPlatform } from '../src/platform.js';
import { Cloud } from '../src/cloud.js';
import { CredentialStore } from '../src/storage.js';
import { DeviceSession } from '../src/session.js';
import { PluginError } from '../src/errors.js';

const noop = () => {};
const log: Logger = Object.assign(noop, { prefix: 'Test', info: noop, success: noop, warn: noop, error: noop, debug: noop, log: noop });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'airplus-platform-'));
  await new CredentialStore(directory).write({ uid: 'synthetic', signingSecret: 'synthetic' });
  const api = new HomebridgeAPI();
  t.mock.method(api.user, 'storagePath', () => directory);
  t.mock.method(CredentialStore.prototype, 'read', async () => ({ uid: 'synthetic', signingSecret: 'synthetic' }));
  const start = t.mock.method(DeviceSession.prototype, 'start', noop);
  const register = t.mock.method(api, 'registerPlatformAccessories', noop);
  t.mock.method(api, 'updatePlatformAccessories', noop);
  const platform = new PhilipsAirPlusPlatform(log, { platform: 'PhilipsAirPlus', deviceId: 'synthetic-device' }, api);
  const devices = t.mock.method(Cloud.prototype, 'devices', async () => [{ id: 'synthetic-device', model: 'HU1509/00', name: 'Humidifier' }]);
  t.after(async () => { api.emit('shutdown'); await rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return { api, platform, devices, start, register };
}

test('cached accessories are unavailable before authentication succeeds', async () => {
  const api = new HomebridgeAPI();
  const platform = new PhilipsAirPlusPlatform(log, { platform: 'PhilipsAirPlus', name: 'Humidifier' }, api);
  const accessory = new api.platformAccessory('Humidifier', api.hap.uuid.generate('synthetic-cached'));
  const temperature = accessory.addService(api.hap.Service.TemperatureSensor, 'Temperature').getCharacteristic(api.hap.Characteristic.CurrentTemperature);
  temperature.updateValue(24);
  platform.configureAccessory(accessory);
  await assert.rejects(temperature.handleGetRequest());
});

test('a transient startup cloud failure recovers without restarting Homebridge', async t => {
  const { api, devices, start } = await fixture(t);
  devices.mock.mockImplementationOnce(async () => { throw new PluginError('Cloud request failed'); });
  api.emit('didFinishLaunching');
  await setImmediate();
  assert.equal(start.mock.callCount(), 0);
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(devices.mock.callCount(), 2);
  assert.equal(start.mock.callCount(), 1);
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(devices.mock.callCount(), 2);
});

test('startup retries back off and remain capped at one minute', async t => {
  const { api, devices } = await fixture(t);
  devices.mock.mockImplementation(async () => { throw new PluginError('Cloud request failed'); });
  api.emit('didFinishLaunching');
  await setImmediate();
  for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
    const calls = devices.mock.callCount();
    t.mock.timers.tick(delay - 1);
    await setImmediate();
    assert.equal(devices.mock.callCount(), calls);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(devices.mock.callCount(), calls + 1);
  }
});

test('shutdown cancels pending startup retries', async t => {
  const { api, devices } = await fixture(t);
  devices.mock.mockImplementation(async () => { throw new PluginError('Cloud request failed'); });
  api.emit('didFinishLaunching');
  await setImmediate();
  api.emit('shutdown');
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(devices.mock.callCount(), 1);
});

test('shutdown during discovery cannot register or start a stale session', async t => {
  const { api, devices, start, register } = await fixture(t);
  let resolve!: (value: Awaited<ReturnType<Cloud['devices']>>) => void;
  devices.mock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  api.emit('didFinishLaunching');
  await setImmediate();
  api.emit('shutdown');
  resolve([{ id: 'synthetic-device', model: 'HU1509/00', name: 'Humidifier' }]);
  await setImmediate();
  assert.equal(start.mock.callCount(), 0);
  assert.equal(register.mock.callCount(), 0);
});

test('a late discovery failure after shutdown cannot schedule another retry', async t => {
  const { api, devices } = await fixture(t);
  let reject!: (error: Error) => void;
  devices.mock.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  api.emit('didFinishLaunching');
  await setImmediate();
  api.emit('shutdown');
  reject(new PluginError('Cloud request failed'));
  await setImmediate();
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(devices.mock.callCount(), 1);
});

test('unconfigured or signed-out platforms do not poll the cloud', async t => {
  const { api, devices } = await fixture(t);
  t.mock.method(CredentialStore.prototype, 'read', async () => undefined);
  api.emit('didFinishLaunching');
  await setImmediate();
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(devices.mock.callCount(), 0);
});
