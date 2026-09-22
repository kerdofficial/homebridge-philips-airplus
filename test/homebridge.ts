import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { API } from 'homebridge';
const require = createRequire(import.meta.url);
const modulePath = pathToFileURL(join(dirname(require.resolve('homebridge')), 'api.js')).href;
const implementation: { HomebridgeAPI: new () => API } = await import(modulePath);
export const HomebridgeAPI = implementation.HomebridgeAPI;
