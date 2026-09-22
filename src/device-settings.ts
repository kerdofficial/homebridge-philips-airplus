import { DeviceSession, type DeviceConnectionProvider } from './session.js';
import { fields, type Patch } from './state.js';
import { PluginError } from './errors.js';

export type SettingsSession = Pick<DeviceSession, 'state' | 'start' | 'stop' | 'on' | 'off' | 'command'>;

export class DeviceSettings {
  constructor(private readonly cloud: DeviceConnectionProvider,
    private readonly factory: (cloud: DeviceConnectionProvider, id: string) => SettingsSession = (cloud, id) => new DeviceSession(cloud, id)) {}

  async run(id: string, patch?: Patch) {
    const session = this.factory(this.cloud, id);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); session.off('state', ready); session.off('fault', failed); };
        const ready = () => { if (session.state.available()) { cleanup(); resolve(); } };
        const failed = () => { cleanup(); reject(new PluginError('Device settings connection failed')); };
        const timer = setTimeout(() => { cleanup(); reject(new PluginError('Device settings connection timed out')); }, 20_000);
        session.on('state', ready); session.on('fault', failed);
        session.start();
      });
      if (patch) await session.command(() => patch);
      const timer = session.state.number(fields.timer);
      return {
        timerHours: timer === 0 ? 0 : timer !== undefined && timer >= 2 && timer <= 13 ? timer - 1 : null,
        beep: session.state.number(fields.beep) ?? null,
        standby: session.state.number(fields.standby) ?? null,
      };
    } finally { session.stop(); }
  }
}
