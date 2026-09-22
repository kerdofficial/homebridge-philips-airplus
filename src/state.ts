import { z } from 'zod';

export const fields = {
  power: 'D03102', mode: 'D0310C', humidity: 'D03125', target: 'D03128', temperature: 'D03224',
  lamp: 'D03135', ambient: 'D03137', brightness: 'D03105', timer: 'D03110',
  beep: 'D03130', standby: 'D03134', model: 'D01S05', error: 'D03240',
} as const;
export const modes = { Auto: 0, Sleep: 17, Medium: 19, High: 65 } as const;
export const effects = { Warm: 1, Dawn: 2, Calm: 3, Breath: 4 } as const;
const allowed: Record<string, readonly number[]> = {
  D03102: [0, 1], D0310C: Object.values(modes), D03128: [40, 50, 60, 70],
  D03135: [0, 1, 2], D03137: Object.values(effects), D03105: [0, 115, 123],
  D03110: [0, ...Array.from({ length: 12 }, (_, i) => i + 2)], D03130: [0, 1], D03134: [0, 1],
};
export type Patch = Record<string, number>;
export function validPatch(patch: Patch): boolean {
  return Object.keys(patch).length > 0 && Object.entries(patch).every(([key, value]) => allowed[key]?.includes(value));
}
const documentSchema = z.object({
  version: z.number().int().nonnegative(), timestamp: z.number().optional(),
  state: z.object({ reported: z.record(z.string(), z.unknown()).optional() }),
  metadata: z.object({ reported: z.record(z.string(), z.object({ timestamp: z.number() }).passthrough()) }).optional(),
});
const objectSchema = z.record(z.string(), z.unknown());

export function parseObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start === -1) {
      if (c?.trim() === '') continue;
      if (c !== '{') throw new Error('Invalid frame');
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      objects.push(objectSchema.parse(JSON.parse(text.slice(start, i + 1))));
      start = -1;
    }
  }
  if (start !== -1) throw new Error('Incomplete frame');
  return objects;
}

export class DeviceState {
  reported: Record<string, unknown> = Object.create(null);
  version = -1;
  deviceUpdatedAt = 0;
  connected = false;
  private timestamps: Record<string, number> = Object.create(null);

  accept(topic: string, payload: Record<string, unknown>): boolean {
    if (!/\/(get\/accepted|update\/accepted|update\/documents)$/.test(topic)) return false;
    const parsed = documentSchema.safeParse(payload.current ?? payload);
    if (!parsed.success || !parsed.data.state.reported || parsed.data.version < this.version) return false;
    const doc = parsed.data;
    const full = topic.endsWith('/get/accepted') || topic.endsWith('/update/documents');
    if (full) { this.reported = Object.create(null); this.timestamps = Object.create(null); }
    for (const [key, value] of Object.entries(doc.state.reported ?? {})) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      if (value === null) { delete this.reported[key]; delete this.timestamps[key]; }
      else this.reported[key] = value;
    }
    for (const [key, value] of Object.entries(doc.metadata?.reported ?? {})) this.timestamps[key] = value.timestamp;
    const sensorTimes = [fields.humidity, fields.temperature, 'connected'].map(key => this.timestamps[key] ?? 0);
    this.deviceUpdatedAt = Math.max(0, ...sensorTimes) * 1000;
    this.version = doc.version;
    return true;
  }

  available(now = Date.now()): boolean {
    return this.connected && this.reported.connected !== false && this.version >= 0
      && this.deviceUpdatedAt > 0 && now - this.deviceUpdatedAt <= 600_000 && this.deviceUpdatedAt <= now + 60_000;
  }

  number(key: string): number | undefined {
    const value = this.reported[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  matches(patch: Patch): boolean { return Object.entries(patch).every(([key, value]) => this.reported[key] === value); }
}
