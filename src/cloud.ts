import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { PluginError } from './errors.js';
import type { Credentials } from './storage.js';

const HOST = 'https://www.api.air.philips.com';
const CDC = 'https://cdc.accounts.home.id';
const API_KEY = '4_JGZWlP8eQHpEqkvQElolbA';
const APP_ID = '9fd505fa9c7111e9a1e3061302926720';
export type Fetcher = typeof fetch;

export function signature(timestamp: string, username: string, secret: string): string {
  const encoded = new URLSearchParams({ username }).toString();
  const body = `app_id=${APP_ID}&timestamp=${timestamp}&${encoded}`;
  const inner = createHmac('sha256', secret).update(body).digest('hex');
  return createHmac('sha256', username).update(inner).digest('hex');
}

async function request(fetcher: Fetcher, url: string, init: RequestInit): Promise<unknown> {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) throw new PluginError(response.status === 401 || response.status === 403 ? 'Cloud authentication rejected' : 'Cloud request failed');
    return await response.json();
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError('Cloud request failed');
  }
}

export class EmailAuth {
  private pending: { email: string; token: string; created: number } | undefined;
  constructor(private readonly fetcher: Fetcher = fetch, private readonly now = Date.now) {}

  async send(email: string): Promise<void> {
    if (!z.email().safeParse(email).success) throw new PluginError('Enter a valid email address');
    if (this.pending && this.now() - this.pending.created < 60_000) throw new PluginError('Wait before requesting another code');
    const result = z.object({ errorCode: z.number(), vToken: z.string().optional() }).safeParse(await request(this.fetcher, `${CDC}/accounts.auth.otp.email.sendCode`, {
      method: 'POST', body: new URLSearchParams({ email, apiKey: API_KEY, format: 'json' }),
    }));
    if (!result.success || result.data.errorCode !== 0 || !result.data.vToken) throw new PluginError('Email code request rejected');
    this.pending = { email, token: result.data.vToken, created: this.now() };
  }

  async verify(code: string): Promise<string> {
    const pending = this.pending;
    if (!pending || this.now() - pending.created > 600_000) throw new PluginError('Email code expired; request another code');
    if (!/^\d{6}$/.test(code)) throw new PluginError('Enter the six-digit code');
    const result = z.object({ errorCode: z.number(), UID: z.string().optional() }).safeParse(await request(this.fetcher, `${CDC}/accounts.auth.otp.email.login`, {
      method: 'POST', body: new URLSearchParams({ email: pending.email, code, vToken: pending.token, apiKey: API_KEY, format: 'json' }),
    }));
    if (!result.success || result.data.errorCode !== 0 || !result.data.UID) throw new PluginError('Email code rejected');
    this.pending = undefined;
    return result.data.UID;
  }

  clear(): void { this.pending = undefined; }
}

export interface Device { id: string; name: string; model: string }
export interface Connection { url: string; clientId: string; deviceId: string }
const idSchema = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/);
const deviceSchema = z.object({
  device_id: idSchema,
  device_info: z.object({ modelid: z.string(), name: z.string().optional() }),
});
const envelope = z.object({ meta: z.object({ code: z.number() }), data: z.unknown().optional() });

export class Cloud {
  constructor(private readonly credentials: Credentials, private readonly fetcher: Fetcher = fetch) {}

  private async call(path: string, body?: unknown, token?: string): Promise<unknown> {
    const result = envelope.safeParse(await request(this.fetcher, HOST + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `jwt ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    if (!result.success || result.data.meta.code !== 0) throw new PluginError('Cloud API rejected request');
    return result.data.data;
  }

  private async token(): Promise<string> {
    const time = z.object({ timestamp1: z.union([z.string(), z.number()]) }).safeParse(await this.call('/device/serverTime/'));
    if (!time.success) throw new PluginError('Cloud clock response invalid');
    const timestamp = String(time.data.timestamp1);
    const username = `PHILIPS:${this.credentials.uid.replace(/^PHILIPS:/, '')}`;
    const result = envelope.safeParse(await request(this.fetcher, HOST + '/enduser/v2/getToken/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Signature: signature(timestamp, username, this.credentials.signingSecret) },
      body: JSON.stringify({ timestamp, username, app_id: APP_ID }),
    }));
    const data = result.success && result.data.meta.code === 0 ? z.object({ token: z.string().min(1) }).safeParse(result.data.data) : undefined;
    if (!data?.success) throw new PluginError('Cloud authentication rejected');
    return data.data.token;
  }

  async devices(): Promise<Device[]> {
    const rows = z.array(deviceSchema).safeParse(await this.call('/enduser/deviceList/', undefined, await this.token()));
    if (!rows.success) throw new PluginError('Device list response invalid');
    return rows.data.filter(row => /^HU15(?:09|10)\//.test(row.device_info.modelid)).map(row => ({
      id: row.device_id, name: row.device_info.name || 'Humidifier', model: row.device_info.modelid,
    }));
  }

  async connection(deviceId: string): Promise<Connection> {
    if (!idSchema.safeParse(deviceId).success) throw new PluginError('Device identifier invalid');
    const result = z.object({ mqttinfos: z.array(z.object({
      device_id: z.string(), endpoint: z.string().optional(), host: z.string().optional(),
      path: z.string().optional(), client_id: z.string().min(1),
    })) }).safeParse(await this.call('/enduser/v2/mqttInfo/', { device_id: [deviceId] }, await this.token()));
    const info = result.success ? result.data.mqttinfos.find(row => row.device_id === deviceId) : undefined;
    if (!info) throw new PluginError('MQTT connection response invalid');
    try {
      const endpoint = info.endpoint || info.host || '';
      const url = new URL(endpoint.includes('://') ? endpoint : `wss://${endpoint}`);
      if (info.path) {
        const path = new URL(info.path, url.origin);
        if (path.origin !== url.origin) throw new Error();
        url.pathname = path.pathname;
        url.search = path.search;
      }
      if (url.protocol !== 'wss:' || !url.hostname.endsWith('.amazonaws.com') || url.username || url.password) throw new Error();
      return { url: url.toString(), clientId: info.client_id, deviceId };
    } catch { throw new PluginError('MQTT endpoint invalid'); }
  }
}
