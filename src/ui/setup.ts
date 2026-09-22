import { z } from 'zod';
import { Cloud, EmailAuth, type Fetcher } from '../cloud.js';
import { CredentialStore } from '../storage.js';
import { PluginError } from '../errors.js';
import { DeviceSettings } from '../device-settings.js';
import { fields, type Patch } from '../state.js';
import { configSchema } from '../config.js';

export class SetupService {
  private readonly auth: EmailAuth;
  private secret: string | undefined;
  private busy = false;
  constructor(private readonly store: CredentialStore, private readonly fetcher: Fetcher = fetch,
    private readonly settings: (cloud: Cloud) => Pick<DeviceSettings, 'run'> = cloud => new DeviceSettings(cloud)) { this.auth = new EmailAuth(fetcher); }

  async handle(path: string, payload: unknown): Promise<unknown> {
    if (this.busy) throw new PluginError('Another setup request is in progress');
    this.busy = true;
    try {
      if (path === '/status') return { authenticated: !!await this.store.read() };
      if (path === '/auth/send') {
        const input = z.object({ email: z.email(), signingSecret: z.string().optional() }).safeParse(payload);
        if (!input.success) throw new PluginError('Enter a valid email address');
        const secret = input.data.signingSecret?.trim() || (await this.store.read())?.signingSecret;
        if (!secret) throw new PluginError('Enter the cloud signing key');
        await this.auth.send(input.data.email);
        this.secret = secret;
        return { sent: true };
      }
      if (path === '/auth/verify') {
        const input = z.object({ code: z.string() }).safeParse(payload);
        if (!input.success || !this.secret) throw new PluginError('Request an email code first');
        const uid = await this.auth.verify(input.data.code);
        const credentials = { uid, signingSecret: this.secret };
        const devices = await new Cloud(credentials, this.fetcher).devices();
        await this.store.write(credentials);
        this.secret = undefined;
        return { devices };
      }
      if (path === '/auth/logout') {
        this.auth.clear();
        this.secret = undefined;
        await this.store.clear();
        return { authenticated: false };
      }
      const credentials = await this.store.read();
      if (!credentials) throw new PluginError('Sign in first');
      const cloud = new Cloud(credentials, this.fetcher);
      if (path === '/devices') return { devices: await cloud.devices() };
      if (path === '/device/read' || path === '/device/apply') {
        const input = z.object({
          deviceId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
          timerHours: z.number().int().min(0).max(12).optional(),
          beep: z.boolean().optional(), standby: z.boolean().optional(),
        }).strict().safeParse(payload);
        if (!input.success) throw new PluginError('Check the device settings');
        if (!(await cloud.devices()).some(device => device.id === input.data.deviceId)) throw new PluginError('Select a supported device from this account');
        const patch: Patch = {};
        if (input.data.timerHours !== undefined) patch[fields.timer] = input.data.timerHours ? input.data.timerHours + 1 : 0;
        if (input.data.beep !== undefined) patch[fields.beep] = Number(input.data.beep);
        if (input.data.standby !== undefined) patch[fields.standby] = Number(input.data.standby);
        if (path === '/device/apply' && !Object.keys(patch).length) throw new PluginError('Choose a setting to apply');
        return this.settings(cloud).run(input.data.deviceId, path === '/device/apply' ? patch : undefined);
      }
      if (path === '/config/validate') {
        const config = configSchema.safeParse(payload);
        if (!config.success || !config.data.deviceId) throw new PluginError('Check the device and configuration fields');
        const devices = await cloud.devices();
        if (!devices.some(device => device.id === config.data.deviceId)) throw new PluginError('Select a supported device from this account');
        return { config: config.data };
      }
      throw new PluginError('Unknown setup request');
    } finally { this.busy = false; }
  }
}
