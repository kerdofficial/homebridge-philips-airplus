import { z } from 'zod';
export const PLUGIN = 'homebridge-philips-airplus';
export const PLATFORM = 'PhilipsAirPlus';
export const configSchema = z.object({
  platform: z.literal(PLATFORM).default(PLATFORM), name: z.string().trim().min(1).max(64).default('Humidifier'),
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  temperatureName: z.string().trim().min(1).max(64).default('Temperature'),
  humidityName: z.string().trim().min(1).max(64).default('Humidity'),
  brightnessName: z.string().trim().min(1).max(64).default('Light'),
  temperature: z.boolean().default(true), humidity: z.boolean().default(true),
  brightness: z.boolean().default(true), color: z.boolean().default(true),
}).passthrough().transform(config => {
  for (const key of ['modes', 'lampModes', 'effects', 'timers', 'timerHours', 'beep', 'standby']) delete config[key];
  return config;
});
export type Config = z.infer<typeof configSchema>;
