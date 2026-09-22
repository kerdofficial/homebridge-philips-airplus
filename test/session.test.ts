import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceSession, type Transport } from '../src/session.js';
import { DeviceState, parseObjects } from '../src/state.js';
import type { Connection } from '../src/cloud.js';

const base = '$aws/things/synthetic-device/shadow';
function document(version: number, reported: Record<string, unknown>, clientToken?: string) {
  return { version, state: { reported }, metadata: { reported: { D03125: { timestamp: Math.floor(Date.now() / 1000) } } }, clientToken };
}
class FakeTransport implements Transport {
  message: (topic: string, payload: string) => void = () => {};
  closed: () => void = () => {};
  writes: Record<string, unknown>[] = [];
  version = 1;
  confirm = true;
  async open(_connection: Connection, message: typeof this.message, closed: () => void) { this.message = message; this.closed = closed; }
  async publish(topic: string, payload: string) {
    const body = JSON.parse(payload);
    if (topic.endsWith('/get')) this.message(`${base}/get/accepted`, JSON.stringify(document(this.version, { D01S05: 'HU1509/00', D03125: 45, D03102: 1, D03128: 60 }, body.clientToken)));
    else {
      this.writes.push(body);
      this.message(`${base}/update/accepted`, JSON.stringify({ version: ++this.version, state: { desired: body.state.desired }, clientToken: body.clientToken }));
      if (this.confirm) this.message(`${base}/update/accepted`, JSON.stringify(document(++this.version, body.state.desired)));
    }
  }
  close() {}
}
async function fixture(timeout = 100) {
  const wire = new FakeTransport();
  const session = new DeviceSession({ connection: async () => ({ url: 'wss://synthetic.amazonaws.com/mqtt', clientId: 'synthetic', deviceId: 'synthetic-device' }) }, 'synthetic-device', () => wire, timeout);
  session.start();
  await delay(5);
  return { wire, session };
}

test('full snapshots, partial events, deletion and old versions preserve state correctly', () => {
  const state = new DeviceState();
  state.accept(`${base}/get/accepted`, document(1, { D03125: 45, D03102: 1 }));
  state.accept(`${base}/update/accepted`, document(2, { D03102: 0 }));
  assert.equal(state.number('D03125'), 45);
  state.accept(`${base}/update/accepted`, document(1, { D03102: 1 }));
  assert.equal(state.number('D03102'), 0);
  state.accept(`${base}/update/accepted`, document(3, { D03125: null }));
  assert.equal(state.number('D03125'), undefined);
  state.accept(`${base}/get/accepted`, document(4, { D03125: 50 }));
  assert.equal(state.number('D03102'), undefined);
});

test('cloud response alone does not mark stale sensor data fresh', () => {
  const state = new DeviceState();
  state.connected = true;
  state.accept(`${base}/get/accepted`, { version: 1, timestamp: Date.now() / 1000, state: { reported: { D03125: 45 } } });
  assert.equal(state.available(), false);
});

test('concatenated frames and escaped braces parse without losing objects', () => {
  assert.equal(parseObjects(JSON.stringify({ x: '}"{' }) + '\n{"x":2}').length, 2);
  assert.throws(() => parseObjects('{"x":'));
});

test('startup only reads and control waits for reported confirmation', async () => {
  const { session, wire } = await fixture();
  try {
    assert.equal(wire.writes.length, 0);
    await session.command(() => ({ D03128: 50 }));
    assert.equal(session.state.number('D03128'), 50);
    await assert.rejects(session.command(() => ({ D03125: 99 })), /Unsupported/);
  } finally { session.stop(); }
});

test('desired acknowledgement is insufficient and late reported events still update state', async () => {
  const { session, wire } = await fixture(30);
  wire.confirm = false;
  try {
    await assert.rejects(session.command(() => ({ D03128: 50 })), /deadline|timed out/);
    assert.equal(session.state.number('D03128'), 60);
    wire.message(`${base}/update/accepted`, JSON.stringify(document(20, { D03128: 50 })));
    assert.equal(session.state.number('D03128'), 50);
  } finally { session.stop(); }
});

test('expired queued commands never reach the transport', async () => {
  const { session, wire } = await fixture(30);
  wire.confirm = false;
  try {
    await Promise.allSettled([session.command(() => ({ D03128: 50 })), session.command(() => ({ D03128: 40 }))]);
    await delay(10);
    assert.equal(wire.writes.length, 1);
  } finally { session.stop(); }
});

test('disconnect rejects pending commands and marks the device unavailable', async () => {
  const { session, wire } = await fixture();
  wire.confirm = false;
  try {
    const pending = session.command(() => ({ D03128: 50 }));
    await delay(5);
    wire.closed();
    await assert.rejects(pending, /unavailable/);
    assert.equal(session.state.available(), false);
  } finally { session.stop(); }
});
