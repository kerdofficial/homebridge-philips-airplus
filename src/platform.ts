import { watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { configSchema, PLUGIN, PLATFORM, type Config } from './config.js';
import { Cloud } from './cloud.js';
import { CredentialStore } from './storage.js';
import { DeviceSession } from './session.js';
import { HumidifierAccessory } from './accessory.js';
import { safeError } from './errors.js';

export class PhilipsAirPlusPlatform implements DynamicPlatformPlugin {
  private readonly cached: PlatformAccessory[] = [];
  private readonly config: Config | undefined;
  private session: DeviceSession | undefined;
  private generation = 0;
  constructor(private readonly log: Logger, config: PlatformConfig, private readonly api: API) {
    const parsed = configSchema.safeParse(config);
    if (parsed.success) this.config = parsed.data;
    else this.log.error('Invalid plugin configuration; open the plugin settings.');
    api.on('didFinishLaunching', () => {
      const file = join(api.user.storagePath(), 'philips-airplus', 'credentials.json');
      watchFile(file, { interval: 5000, persistent: false }, () => { void this.launch(); });
      void this.launch();
      api.on('shutdown', () => { ++this.generation; unwatchFile(file); this.session?.stop(); });
    });
  }
  configureAccessory(accessory: PlatformAccessory): void {
    const hap = this.api.hap;
    const unavailable = () => new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    for (const service of accessory.services) {
      if (service.UUID === hap.Service.AccessoryInformation.UUID) continue;
      for (const characteristic of service.characteristics) {
        if ([hap.Characteristic.Name.UUID, hap.Characteristic.ConfiguredName.UUID].includes(characteristic.UUID)) continue;
        characteristic.updateValue(unavailable());
        characteristic.onGet(() => { throw unavailable(); });
        if (characteristic.props.perms.includes(hap.Perms.PAIRED_WRITE)) characteristic.onSet(() => { throw unavailable(); });
      }
    }
    this.cached.push(accessory);
  }

  private async launch(): Promise<void> {
    const generation = ++this.generation;
    this.session?.stop();
    const config = this.config;
    if (!config?.deviceId) { this.log.info('Select a humidifier in the plugin settings.'); return; }
    try {
      const credentials = await new CredentialStore(this.api.user.storagePath()).read();
      if (!credentials) { this.log.warn('Sign in using the plugin settings.'); return; }
      const cloud = new Cloud(credentials);
      const device = (await cloud.devices()).find(device => device.id === config.deviceId);
      if (generation !== this.generation) return;
      if (!device) { this.log.error('Selected humidifier is not available in this account.'); return; }
      const uuid = this.api.hap.uuid.generate(`${PLUGIN}:${device.id}`);
      let accessory = this.cached.find(accessory => accessory.UUID === uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(config.name, uuid);
        this.cached.push(accessory);
        this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
      }
      const obsolete = this.cached.filter(item => item.UUID !== uuid);
      if (obsolete.length) {
        this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, obsolete);
        for (const item of obsolete) this.cached.splice(this.cached.indexOf(item), 1);
      }
      accessory.displayName = config.name;
      accessory.context.model = device.model;
      const session = new DeviceSession(cloud, device.id);
      this.session = session;
      session.on('fault', code => this.log.warn(code));
      new HumidifierAccessory(this.api, accessory, config, session);
      this.api.updatePlatformAccessories([accessory]);
      session.start();
    } catch (error) { this.log.error(safeError(error)); }
  }
}
