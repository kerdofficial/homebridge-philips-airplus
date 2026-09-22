import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DeviceSettings } from '../src/device-settings.js';
import { DeviceState, type Patch } from '../src/state.js';

class SettingsSession extends EventEmitter<{ state: []; fault: [string] }> {
  state = new DeviceState();
  stopped = false;
  fail = false;
  start() {
    if (this.fail) { this.emit('fault', 'Synthetic failure'); return; }
    this.state.connected = true; this.state.version = 1; this.state.deviceUpdatedAt = Date.now();
    this.state.reported = { D03110: 3, D03130: 1, D03134: 0 };
    this.emit('state');
  }
  stop() { this.stopped = true; }
  async command(build: (state: DeviceState) => Patch | undefined) { Object.assign(this.state.reported, build(this.state)); }
}
const cloud = { async connection() { throw new Error('Not used'); } };

test('device settings return confirmed values and always release the connection', async () => {
  const session = new SettingsSession();
  const settings = new DeviceSettings(cloud, () => session);
  assert.deepEqual(await settings.run('synthetic-device', { D03110: 5 }), { timerHours: 4, beep: 1, standby: 0 });
  assert.equal(session.stopped, true);
  assert.equal(session.listenerCount('state'), 0);
});

test('device settings close failed sessions without exposing transport errors', async () => {
  const session = new SettingsSession(); session.fail = true;
  await assert.rejects(new DeviceSettings(cloud, () => session).run('synthetic-device'), /Device settings connection failed/);
  assert.equal(session.stopped, true);
  assert.equal(session.listenerCount('fault'), 0);
});
