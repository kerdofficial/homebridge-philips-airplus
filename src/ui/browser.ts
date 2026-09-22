import '@homebridge/plugin-ui-utils/ui.interface';
import { z } from 'zod';
import { configSchema, groups, type Config } from '../config.js';

function element(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing interface element');
  return element;
}
function input(id: string): HTMLInputElement {
  const value = element(id);
  if (!(value instanceof HTMLInputElement)) throw new Error('Missing input');
  return value;
}
const deviceSelect = element('device');
if (!(deviceSelect instanceof HTMLSelectElement)) throw new Error('Missing device selector');
const select = deviceSelect;
const fields = element('setup-fields');
if (!(fields instanceof HTMLFieldSetElement)) throw new Error('Missing form fields');
const fieldset = fields;
let config: Config = configSchema.parse({});

async function request(path: string, payload?: unknown): Promise<unknown> {
  const response: unknown = await window.homebridge.request(path, payload);
  return z.object({ result: z.unknown() }).parse(response).result;
}
function notice(message: string, error = false): void {
  element('notice').textContent = message;
  element('notice').classList.toggle('error', error);
}
async function run(action: () => Promise<void>): Promise<void> {
  fieldset.disabled = true;
  notice('Working...');
  try { await action(); }
  catch (error) {
    const parsed = z.object({ message: z.string() }).safeParse(error);
    notice(parsed.success ? parsed.data.message : 'Request failed. Check the connection and try again.', true);
  } finally { fieldset.disabled = false; }
}
function timerVisibility(): void { element('timer-options').hidden = !input('group-timers').checked; }
function fill(): void {
  input('name').value = config.name;
  input('temperature-name').value = config.temperatureName;
  input('humidity-name').value = config.humidityName;
  for (const key of Object.keys(groups)) {
    const group = config[key];
    input(`group-${key}`).checked = group === true;
  }
  for (let hour = 1; hour <= 12; hour++) input(`hour-${hour}`).checked = config.timerHours.includes(hour);
  timerVisibility();
}
function showDevices(payload: unknown): void {
  const { devices } = z.object({ devices: z.array(z.object({ id: z.string(), name: z.string(), model: z.string() })) }).parse(payload);
  select.replaceChildren(new Option('Select a humidifier', ''));
  for (const device of devices) select.add(new Option(`${device.name} (${device.model})`, device.id));
  select.value = config.deviceId ?? '';
  element('config-form').hidden = false;
  element('logout').hidden = false;
  element('connection-status').textContent = 'Signed in';
  notice(devices.length ? 'Select your humidifier and save its settings.' : 'No supported HU1509 or HU1510 humidifier was found.');
}
for (const [key, name] of Object.entries(groups)) {
  const label = document.createElement('label');
  label.className = 'control-row';
  const text = document.createElement('span');
  text.textContent = name;
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.id = `group-${key}`;
  label.append(text, checkbox); element('groups').append(label);
}
for (let hour = 1; hour <= 12; hour++) {
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.id = `hour-${hour}`;
  label.append(checkbox, document.createTextNode(`${hour} h`)); element('hours').append(label);
}
input('group-timers').addEventListener('change', timerVisibility);
element('auth-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    try { await request('/auth/send', { email: input('email').value, signingSecret: input('secret').value }); }
    finally { input('secret').value = ''; }
    element('code-form').hidden = false;
    notice('Check your email for a six-digit code.');
    setTimeout(() => input('code').focus(), 0);
  });
});
element('code-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    let result: unknown;
    try { result = await request('/auth/verify', { code: input('code').value }); }
    finally { input('code').value = ''; }
    element('code-form').hidden = true;
    input('email').value = '';
    showDevices(result);
  });
});
element('logout').addEventListener('click', () => {
  void run(async () => {
    await request('/auth/logout');
    element('config-form').hidden = true; element('code-form').hidden = true; element('logout').hidden = true;
    input('email').value = ''; input('secret').value = ''; input('code').value = '';
    select.replaceChildren(new Option('Select a humidifier', ''));
    element('connection-status').textContent = 'Not signed in';
    notice('Signed out. The device connection will close shortly.');
  });
});
element('config-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const visible = Object.fromEntries(Object.keys(groups).map(key => [key, input(`group-${key}`).checked]));
    const hours = Array.from({ length: 12 }, (_, i) => i + 1).filter(hour => input(`hour-${hour}`).checked);
    if (input('group-timers').checked && !hours.length) { notice('Select at least one timer duration.', true); return; }
    const proposed = { ...config, ...visible, deviceId: select.value, name: input('name').value,
      temperatureName: input('temperature-name').value, humidityName: input('humidity-name').value, timerHours: hours.length ? hours : [1, 2, 4] };
    const response = z.object({ config: configSchema }).parse(await request('/config/validate', proposed));
    config = response.config;
    await window.homebridge.updatePluginConfig([config]);
    await window.homebridge.savePluginConfig();
    notice('Settings saved. Restart the child bridge to apply them, then pair it in Apple Home.');
  });
});
void run(async () => {
  const existing: unknown = await window.homebridge.getPluginConfig();
  const configs = z.array(z.unknown()).parse(existing);
  config = configSchema.parse(configs[0] ?? {});
  fill();
  const status = z.object({ authenticated: z.boolean() }).parse(await request('/status'));
  if (status.authenticated) showDevices(await request('/devices'));
  else { element('connection-status').textContent = 'Not signed in'; notice('Sign in to discover your humidifier.'); }
});
