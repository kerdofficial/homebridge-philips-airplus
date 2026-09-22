import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import type { Connection } from './cloud.js';
import { DeviceState, fields, parseObjects, validPatch, type Patch } from './state.js';
import { PluginError, safeError } from './errors.js';

export interface Transport {
  open(connection: Connection, message: (topic: string, payload: string) => void, closed: () => void): Promise<void>;
  publish(topic: string, payload: string): Promise<void>;
  close(): void;
}

export class MqttTransport implements Transport {
  private client: MqttClient | undefined;
  async open(connection: Connection, message: (topic: string, payload: string) => void, closed: () => void): Promise<void> {
    const client = mqtt.connect(connection.url, {
      clientId: connection.clientId, reconnectPeriod: 0, connectTimeout: 15_000,
      clean: true, keepalive: 30, protocolVersion: 4, queueQoSZero: false,
    });
    this.client = client;
    client.on('message', (topic, bytes) => message(topic, bytes.toString('utf8')));
    client.on('close', closed);
    client.on('error', () => { client.end(true); });
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new PluginError('MQTT connection failed'));
      client.once('close', failed);
      client.once('connect', () => {
        const base = `$aws/things/${connection.deviceId}/shadow`;
        client.subscribe(['get/accepted', 'get/rejected', 'update/accepted', 'update/rejected', 'update/documents'].map(suffix => `${base}/${suffix}`), { qos: 1 }, (error, grants) => {
          client.removeListener('close', failed);
          if (error || !grants?.length || grants.some(grant => grant.qos === 128)) reject(new PluginError('MQTT subscription rejected'));
          else resolve();
        });
      });
    });
  }
  async publish(topic: string, payload: string): Promise<void> {
    const client = this.client;
    if (!client?.connected) throw new PluginError('Device connection unavailable');
    await client.publishAsync(topic, payload, { qos: 1 });
  }
  close(): void { this.client?.end(true); }
}

interface Pending {
  operation: 'get' | 'update'; version: number; patch?: Patch;
  resolve: () => void; reject: (error: PluginError) => void; timer: NodeJS.Timeout;
}
export interface DeviceConnectionProvider { connection(id: string): Promise<Connection> }

export class DeviceSession extends EventEmitter<{ state: []; fault: [string] }> {
  readonly state = new DeviceState();
  private transport: Transport | undefined;
  private stopped = true;
  private generation = 0;
  private failures = 0;
  private retry: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private freshness: NodeJS.Timeout | undefined;
  private pending = new Map<string, Pending>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly cloud: DeviceConnectionProvider, readonly deviceId: string,
    private readonly transportFactory: () => Transport = () => new MqttTransport(), private readonly timeout = 8000) { super(); }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.freshness = setInterval(() => this.emit('state'), 5000);
    void this.connect();
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    try {
      const connection = await this.cloud.connection(this.deviceId);
      if (this.stopped || generation !== this.generation) return;
      const transport = this.transportFactory();
      this.transport = transport;
      await transport.open(connection, (topic, payload) => {
        if (generation === this.generation) this.receive(topic, payload);
      }, () => { if (generation === this.generation) this.disconnect(); });
      if (this.stopped || generation !== this.generation) { transport.close(); return; }
      this.state.connected = true;
      await this.refresh();
      if (generation !== this.generation) return;
      this.failures = 0;
      this.poll = setInterval(() => { void this.refresh().catch(() => this.disconnect()); }, 60_000);
      this.emit('state');
    } catch (error) {
      if (!this.stopped && generation === this.generation) {
        this.emit('fault', safeError(error));
        this.disconnect();
      }
    }
  }

  private disconnect(): void {
    ++this.generation;
    this.state.connected = false;
    clearInterval(this.poll);
    this.transport?.close();
    this.transport = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new PluginError('Device connection unavailable'));
    }
    this.pending.clear();
    this.emit('state');
    if (!this.stopped) {
      clearTimeout(this.retry);
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6)) * (0.8 + Math.random() * 0.2);
      this.retry = setTimeout(() => { void this.connect(); }, delay);
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.freshness);
    this.disconnect();
  }

  private receive(topic: string, text: string): void {
    if (!topic.startsWith(`$aws/things/${this.deviceId}/shadow/`)) return;
    try {
      for (const payload of parseObjects(text)) {
        const accepted = this.state.accept(topic, payload);
        const token = typeof payload.clientToken === 'string' ? payload.clientToken : '';
        for (const [id, pending] of this.pending) {
          const rejected = token === id && topic.endsWith(`/${pending.operation}/rejected`);
          const confirmed = pending.operation === 'get'
            ? accepted && token === id && topic.endsWith('/get/accepted')
            : accepted && this.state.version > pending.version && !!pending.patch && this.state.matches(pending.patch);
          if (rejected || confirmed) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            if (rejected) pending.reject(new PluginError('Cloud rejected command'));
            else pending.resolve();
          }
        }
        if (accepted) this.emit('state');
      }
    } catch { this.emit('fault', 'Invalid MQTT state frame'); }
  }

  private request(operation: 'get' | 'update', duration: number, patch?: Patch): Promise<void> {
    const transport = this.transport;
    if (!transport || !this.state.connected) return Promise.reject(new PluginError('Device connection unavailable'));
    const token = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new PluginError('Device confirmation timed out'));
      }, Math.max(1, duration));
      this.pending.set(token, { operation, version: this.state.version, resolve, reject, timer, ...(patch ? { patch } : {}) });
      void transport.publish(`$aws/things/${this.deviceId}/shadow/${operation}`, JSON.stringify({ clientToken: token, ...(patch ? { state: { desired: patch } } : {}) })).catch(() => {
        const pending = this.pending.get(token);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(token);
        pending.reject(new PluginError('MQTT publish failed'));
      });
    });
  }

  refresh(): Promise<void> { return this.request('get', this.timeout); }

  command(build: (state: DeviceState) => Patch | undefined): Promise<void> {
    const deadline = Date.now() + this.timeout;
    const work = this.queue.then(async () => {
      if (Date.now() >= deadline) throw new PluginError('Queued command expired');
      if (!this.state.available()) throw new PluginError('Device state unavailable or stale');
      if (!/^HU15(?:09|10)\//.test(String(this.state.reported[fields.model]))) throw new PluginError('Unsupported reported model');
      const patch = build(this.state);
      if (!patch) return;
      if (!validPatch(patch)) throw new PluginError('Unsupported device command');
      if (this.state.matches(patch)) return;
      await this.request('update', deadline - Date.now(), patch);
    });
    this.queue = work.catch(() => {});
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PluginError('Command deadline exceeded')), this.timeout);
      void work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
}
