import { z } from 'zod';
export const PLUGIN = 'homebridge-philips-airplus';
export const PLATFORM = 'PhilipsAirPlus';
export const groups = {
  temperature: 'Temperature sensor', humidity: 'Humidity sensor', modes: 'Operating modes',
  lampModes: 'Lamp modes', effects: 'Ambient effects', brightness: 'Brightness',
  timers: 'Timers', beep: 'Sound feedback', standby: 'Standby sensors',
} as const;
export const configSchema = z.object({
  platform: z.literal(PLATFORM).default(PLATFORM), name: z.string().trim().min(1).max(64).default('Humidifier'),
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  temperatureName: z.string().trim().min(1).max(64).default('Temperature'),
  humidityName: z.string().trim().min(1).max(64).default('Humidity'),
  temperature: z.boolean().default(true), humidity: z.boolean().default(true), modes: z.boolean().default(true),
  lampModes: z.boolean().default(true), effects: z.boolean().default(true), brightness: z.boolean().default(true),
  timers: z.boolean().default(false), beep: z.boolean().default(false), standby: z.boolean().default(false),
  timerHours: z.array(z.number().int().min(1).max(12)).min(1).default([1, 2, 4]).transform(hours => [...new Set(hours)].sort((a, b) => a - b)),
}).passthrough();
export type Config = z.infer<typeof configSchema>;
