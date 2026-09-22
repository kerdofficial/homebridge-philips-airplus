import type { API } from 'homebridge';
import { PLUGIN, PLATFORM } from './config.js';
import { PhilipsAirPlusPlatform } from './platform.js';
export default function register(api: API): void {
  api.registerPlatform(PLUGIN, PLATFORM, PhilipsAirPlusPlatform);
}
