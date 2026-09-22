import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'homebridge';
import { HomebridgeAPI } from './homebridge.js';
import { PhilipsAirPlusPlatform } from '../src/platform.js';

const noop = () => {};
const log: Logger = Object.assign(noop, { prefix: 'Test', info: noop, success: noop, warn: noop, error: noop, debug: noop, log: noop });

test('cached accessories are unavailable before authentication succeeds', async () => {
  const api = new HomebridgeAPI();
  const platform = new PhilipsAirPlusPlatform(log, { platform: 'PhilipsAirPlus', name: 'Humidifier' }, api);
  const accessory = new api.platformAccessory('Humidifier', api.hap.uuid.generate('synthetic-cached'));
  const temperature = accessory.addService(api.hap.Service.TemperatureSensor, 'Temperature').getCharacteristic(api.hap.Characteristic.CurrentTemperature);
  temperature.updateValue(24);
  platform.configureAccessory(accessory);
  await assert.rejects(temperature.handleGetRequest());
});
