import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as settled } from 'node:timers/promises';
import type { Characteristic, CharacteristicValue } from 'homebridge';
import { HomebridgeAPI } from './homebridge.js';
import register from '../src/index.js';
import { HumidifierAccessory } from '../src/accessory.js';
import { configSchema } from '../src/config.js';
import { DeviceState, type Patch } from '../src/state.js';

class FakeSession extends EventEmitter<{ state: [] }> {
  state = new DeviceState();
  patches: Patch[] = [];
  fail = false;
  async command(build: (state: DeviceState) => Patch | undefined) {
    if (!this.state.available() || this.fail) throw new Error('Unavailable');
    const patch = build(this.state);
    if (patch) { this.patches.push(patch); Object.assign(this.state.reported, patch); }
    this.emit('state');
  }
}
function fixture() {
  const api = new HomebridgeAPI();
  const accessory = new api.platformAccessory('Humidifier', api.hap.uuid.generate('synthetic-device'));
  const session = new FakeSession();
  session.state.connected = true;
  session.state.version = 1;
  session.state.deviceUpdatedAt = Date.now();
  session.state.reported = { D03102: 1, D0310C: 0, D03125: 45, D03128: 60, D03224: 240, D03135: 2, D03137: 1, D03105: 123 };
  const config = configSchema.parse({});
  new HumidifierAccessory(api, accessory, config, session);
  function control(subtype: string, type: typeof api.hap.Characteristic.On): Characteristic {
    const service = accessory.services.find(service => service.subtype === subtype);
    assert.ok(service);
    return service.getCharacteristic(type);
  }
  return { api, accessory, session, config, control, C: api.hap.Characteristic };
}
async function write(characteristic: Characteristic, value: CharacteristicValue) {
  characteristic.validateClientSuppliedValue(value);
  await characteristic.handleSetRequest(value);
  await settled();
}

test('all slider positions and intermediate Home requests map to confirmed cloud commands', async () => {
  const { session, control, C } = fixture();
  const slider = control('humidifier', C.RelativeHumidityHumidifierThreshold);
  for (const value of [18, 20, 25, 30]) {
    await write(slider, value);
    assert.deepEqual(session.patches.at(-1), { D03102: 1, D0310C: 19 });
    assert.equal(slider.value, 25);
  }
  for (const target of [40, 50, 60, 70]) {
    await write(slider, target);
    assert.deepEqual(session.patches.at(-1), { D03102: 1, D0310C: 0, D03128: target });
  }
  await write(slider, 47); assert.equal(slider.value, 50);
  await write(slider, 100); assert.equal(session.state.number('D0310C'), 65);
  await write(slider, 0); assert.equal(session.state.number('D03102'), 0);
  assert.equal(slider.value, 0);
});

test('brightness accepts the entire range and remains off with the humidifier', async () => {
  const { session, control, C } = fixture();
  const brightness = control('brightness', C.Brightness);
  for (let value = 0; value <= 100; value++) {
    await write(brightness, value);
    const expected = value <= 25 ? 0 : value <= 75 ? 50 : 100;
    assert.equal(brightness.value, expected);
    assert.equal(control('brightness', C.On).value, expected > 0);
  }
  await write(brightness, 50);
  await write(control('humidifier', C.Active), 0);
  assert.equal(brightness.value, 0);
  const writes = session.patches.length;
  await write(brightness, 100); await write(control('brightness', C.On), true);
  assert.equal(session.patches.length, writes);
  assert.equal(brightness.value, 0);
  await write(control('humidifier', C.Active), 1);
  assert.equal(brightness.value, 50);
  await write(brightness, 0);
  await write(control('humidifier', C.Active), 0);
  await write(control('humidifier', C.Active), 1);
  assert.equal(brightness.value, 0);
  await write(control('brightness', C.On), true);
  assert.equal(brightness.value, 50);
});

test('upgrades preserve a saved low brightness when the device is off', async () => {
  const { api, accessory, config, session, control, C } = fixture();
  session.state.reported.D03102 = 0;
  accessory.context.lastBrightness = 115;
  delete accessory.context.poweredBrightness;
  new HumidifierAccessory(api, accessory, config, session);
  await write(control('humidifier', C.Active), 1);
  assert.equal(session.state.number('D03105'), 115);
  assert.equal(control('brightness', C.Brightness).value, 50);
});

test('colors select Ambient and fixed effects without changing power or brightness', async () => {
  const { session, control, C } = fixture();
  for (const [hue, effect, reported] of [[45, 1, 48], [25, 2, 25], [210, 3, 190], [360, 2, 25]]) {
    assert.ok(hue !== undefined && effect !== undefined && reported !== undefined);
    await write(control('brightness', C.Hue), hue);
    assert.deepEqual(session.patches.at(-1), { D03135: 2, D03137: effect });
    assert.equal(control('brightness', C.Hue).value, reported);
  }
  const count = session.patches.length;
  await write(control('brightness', C.Saturation), 32);
  assert.equal(session.patches.length, count);
  assert.equal(control('brightness', C.Saturation).value, 75);
  await write(control('humidifier', C.Active), 0);
  await write(control('brightness', C.Hue), 190);
  assert.equal(session.state.number('D03137'), 2);
});

test('app updates refresh the slider and unsupported effects use a neutral indicator', async () => {
  const { session, control, C } = fixture();
  Object.assign(session.state.reported, { D0310C: 17, D03137: 4 }); session.emit('state');
  assert.equal(control('humidifier', C.RelativeHumidityHumidifierThreshold).value, 25);
  assert.equal(control('brightness', C.Saturation).value, 0);
  Object.assign(session.state.reported, { D0310C: 0, D03128: 70 }); session.emit('state');
  assert.equal(control('humidifier', C.RelativeHumidityHumidifierThreshold).value, 70);
});

test('migration removes old switches, preserves services and user names across reloads', async () => {
  const { api, accessory, session, config, control, C } = fixture();
  const primary = accessory.services.find(service => service.subtype === 'humidifier');
  accessory.addService(api.hap.Service.Switch, 'Auto', 'mode-auto');
  await write(control('brightness', C.ConfiguredName), 'Custom light');
  const originalUuid = accessory.UUID;
  new HumidifierAccessory(api, accessory, { ...config, name: 'Renamed', color: false }, session);
  assert.equal(accessory.UUID, originalUuid);
  assert.equal(accessory.services.find(service => service.subtype === 'humidifier'), primary);
  assert.equal(accessory.services.some(service => service.UUID === api.hap.Service.Switch.UUID), false);
  assert.equal(control('brightness', C.ConfiguredName).value, 'Custom light');
  assert.equal(accessory.services.find(service => service.subtype === 'brightness')?.testCharacteristic(C.Hue), false);
  assert.equal(control('humidifier', C.ConfiguredName).value, 'Renamed');
});

test('failed writes and stale or missing readings are not shown as successful values', async () => {
  const { session, control, C } = fixture();
  const temperature = control('temperature', C.CurrentTemperature);
  assert.equal(await temperature.handleGetRequest(), 24);
  session.fail = true;
  await assert.rejects(write(control('brightness', C.Brightness), 20));
  assert.equal(session.state.number('D03105'), 123);
  delete session.state.reported.D03224;
  await assert.rejects(temperature.handleGetRequest());
  session.state.deviceUpdatedAt = 1;
  await assert.rejects(control('humidifier', C.CurrentRelativeHumidity).handleGetRequest());
});

test('configuration drops retired switches but retains child bridge settings', () => {
  const config = configSchema.parse({ modes: true, effects: true, timers: true, _bridge: { name: 'Example child' } });
  assert.equal(config.modes, undefined);
  assert.deepEqual(config._bridge, { name: 'Example child' });
});

test('plugin entry point registers with the installed Homebridge API', () => {
  assert.doesNotThrow(() => register(new HomebridgeAPI()));
});
