import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HomebridgeAPI } from './homebridge.js';
import register from '../src/index.js';
import { HumidifierAccessory } from '../src/accessory.js';
import { configSchema } from '../src/config.js';
import { DeviceState, type Patch } from '../src/state.js';

class FakeSession extends EventEmitter<{ state: [] }> {
  state = new DeviceState();
  patches: Patch[] = [];
  async command(build: (state: DeviceState) => Patch | undefined) {
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
  session.state.reported = { D03102: 1, D0310C: 0, D03125: 45, D03128: 60, D03224: 240, D03135: 2, D03137: 4, D03105: 123, D03110: 0, D03130: 1, D03134: 1 };
  const config = configSchema.parse({ timers: true, beep: true, standby: true });
  new HumidifierAccessory(api, accessory, config, session);
  function control(subtype: string) {
    const service = accessory.services.find(service => service.subtype === subtype);
    assert.ok(service);
    return service.getCharacteristic(api.hap.Characteristic.On);
  }
  return { api, accessory, session, config, control };
}

test('mode selectors start the selected mode, ignore inactive off and stop active mode', async () => {
  const { session, control } = fixture();
  await control('mode-sleep').handleSetRequest(true);
  assert.deepEqual(session.patches.at(-1), { D03102: 1, D0310C: 17 });
  assert.equal(await control('mode-auto').handleGetRequest(), false);
  await control('mode-auto').handleSetRequest(false);
  assert.equal(session.patches.length, 1);
  await control('mode-sleep').handleSetRequest(false);
  assert.equal(session.state.number('D03102'), 0);
});

test('effect selection activates Ambient and turning it off only affects the lamp', async () => {
  const { session, control } = fixture();
  await control('effect-warm').handleSetRequest(true);
  assert.deepEqual(session.patches.at(-1), { D03135: 2, D03137: 1 });
  await control('effect-warm').handleSetRequest(false);
  assert.deepEqual(session.patches.at(-1), { D03135: 0 });
  assert.equal(session.state.number('D03102'), 1);
});

test('timers replace one another and active off cancels the device timer', async () => {
  const { session, control } = fixture();
  await control('timer-2').handleSetRequest(true);
  assert.equal(session.state.number('D03110'), 3);
  await control('timer-4').handleSetRequest(true);
  assert.equal(await control('timer-2').handleGetRequest(), false);
  await control('timer-4').handleSetRequest(false);
  assert.equal(session.state.number('D03110'), 0);
});

test('brightness retains the last nonzero setting independently of the ambient lamp', async () => {
  const { api, accessory, session, control } = fixture();
  const brightness = accessory.services.find(service => service.subtype === 'brightness')!.getCharacteristic(api.hap.Characteristic.Brightness);
  await brightness.handleSetRequest(50);
  await control('brightness').handleSetRequest(false);
  await control('brightness').handleSetRequest(true);
  assert.equal(session.state.number('D03105'), 115);
  assert.equal(session.state.number('D03135'), 2);
});

test('renaming and disabling services preserves retained service identity', () => {
  const { api, accessory, session, config } = fixture();
  const primary = accessory.services.find(service => service.subtype === 'humidifier');
  new HumidifierAccessory(api, accessory, { ...config, name: 'Renamed', modes: false }, session);
  assert.equal(accessory.services.find(service => service.subtype === 'humidifier'), primary);
  assert.equal(accessory.services.some(service => service.subtype === 'mode-auto'), false);
});

test('sensor reads expose real units and fail when stale', async () => {
  const { api, accessory, session } = fixture();
  const temperature = accessory.services.find(service => service.subtype === 'temperature')!.getCharacteristic(api.hap.Characteristic.CurrentTemperature);
  assert.equal(await temperature.handleGetRequest(), 24);
  session.state.deviceUpdatedAt = 1;
  await assert.rejects(temperature.handleGetRequest());
});

test('plugin entry point registers with the installed Homebridge API', () => {
  assert.doesNotThrow(() => register(new HomebridgeAPI()));
});
