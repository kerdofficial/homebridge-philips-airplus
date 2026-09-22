import '@homebridge/plugin-ui-utils/ui.interface';
import type { IHomebridgeUiFormHelper, PluginFormSchema } from '@homebridge/plugin-ui-utils/ui.interface';
import { z } from 'zod';
import { configSchema, type Config } from '../config.js';

const homebridge = window.homebridge;
let config: Config = configSchema.parse({});
let activeForm: IHomebridgeUiFormHelper | undefined;
let authenticated = false;
let busy = false;
function element(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing interface element');
  return element;
}
function notice(message: string): void { element('notice').textContent = message; }
async function request(path: string, payload?: unknown): Promise<unknown> {
  const response: unknown = await homebridge.request(path, payload);
  return z.object({ result: z.unknown() }).parse(response).result;
}
async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  homebridge.showSpinner();
  try { await action(); }
  catch (error) {
    const parsed = z.object({ message: z.string() }).safeParse(error);
    notice(parsed.success ? parsed.data.message : 'Request failed. Check the connection and try again.');
  } finally { busy = false; homebridge.hideSpinner(); }
}
function endForm(): void { activeForm?.end(); activeForm = undefined; }
function configuration(): void {
  endForm();
  element('signed-in').hidden = !authenticated;
  element('signin').textContent = authenticated ? 'Sign in again' : 'Sign in';
  homebridge.showSchemaForm();
  if (config.deviceId) homebridge.enableSaveButton();
  else homebridge.disableSaveButton();
}
function form(schema: PluginFormSchema, data: Record<string, unknown>, submit: string, action: (data: unknown) => Promise<void>): void {
  endForm(); homebridge.hideSchemaForm(); homebridge.disableSaveButton();
  activeForm = homebridge.createForm(schema, data, submit, 'Back');
  activeForm.onSubmit((data: unknown) => { void run(() => action(data)); });
  activeForm.onCancel(configuration);
}
async function chooseDevice(): Promise<void> {
  const { devices } = z.object({ devices: z.array(z.object({ id: z.string(), name: z.string(), model: z.string() })) }).parse(await request('/devices'));
  if (!devices.length) { configuration(); notice('No supported HU1509 or HU1510 humidifier was found.'); return; }
  form({ schema: { type: 'object', properties: { deviceId: { title: 'Humidifier', type: 'string', required: true,
    oneOf: devices.map(device => ({ title: `${device.name} (${device.model})`, enum: [device.id] })) } } } },
  { deviceId: devices.some(device => device.id === config.deviceId) ? config.deviceId : devices[0]?.id }, 'Select device', async payload => {
    const selection = z.object({ deviceId: z.string() }).parse(payload);
    const result = z.object({ config: configSchema }).parse(await request('/config/validate', { ...config, ...selection }));
    config = result.config;
    await homebridge.updatePluginConfig([config]);
    configuration(); notice('Device selected. Review the settings below and use Homebridge Save.');
  });
}
function signIn(): void {
  form({ schema: { type: 'object', properties: {
    email: { title: 'Philips account email', type: 'string', format: 'email', required: true },
    signingSecret: { title: 'Cloud signing key', type: 'string', format: 'password', description: 'Leave blank to keep a saved key. Stored privately, not in plugin configuration.' },
  } } , layout: [{ key: 'email' }, { key: 'signingSecret', type: 'password' }] }, {}, 'Send sign-in code', async payload => {
    const input = z.object({ email: z.email(), signingSecret: z.string().optional() }).parse(payload);
    await request('/auth/send', input);
    form({ schema: { type: 'object', properties: { code: { title: 'Email verification code', type: 'string', pattern: '^[0-9]{6}$', required: true } } } },
      {}, 'Verify code', async payload => {
        const input = z.object({ code: z.string() }).parse(payload);
        await request('/auth/verify', input);
        authenticated = true;
        await chooseDevice();
      });
    notice('Check your email for a six-digit code.');
  });
}
async function deviceSettings(): Promise<void> {
  if (!config.deviceId) { notice('Select a humidifier first.'); return; }
  const deviceId = config.deviceId;
  const status = z.object({ timerHours: z.number().nullable(), beep: z.number().nullable(), standby: z.number().nullable() }).parse(await request('/device/read', { deviceId }));
  const toggleLabel = (value: number | null) => value === null ? 'unknown' : value === 1 ? 'On' : 'Off';
  notice(`Current timer: ${status.timerHours === null ? 'unknown' : `${status.timerHours} h`}. Sound feedback: ${toggleLabel(status.beep)}. Standby sensors: ${toggleLabel(status.standby)}. Choose one setting to change; other settings are preserved.`);
  form({ schema: { type: 'object', properties: {
    setting: { title: 'Setting to change', type: 'string', required: true, oneOf: [
      { title: 'Sleep timer', enum: ['timerHours'] }, { title: 'Sound feedback', enum: ['beep'] }, { title: 'Standby sensors', enum: ['standby'] },
    ] },
    timerHours: { title: 'Sleep timer (0 = Off)', type: 'integer', minimum: 0, maximum: 12 },
    enabled: { title: 'Enable sound feedback or standby sensors', type: 'boolean' },
  } } }, { setting: 'timerHours', timerHours: status.timerHours ?? 0, enabled: true }, 'Apply to device', async payload => {
    const input = z.object({ setting: z.enum(['timerHours', 'beep', 'standby']), timerHours: z.number().int().min(0).max(12), enabled: z.boolean() }).parse(payload);
    await request('/device/apply', { deviceId, [input.setting]: input.setting === 'timerHours' ? input.timerHours : input.enabled });
    configuration(); notice('Device confirmed the setting. This is not a startup default.');
  });
}
element('signin').addEventListener('click', signIn);
element('select-device').addEventListener('click', () => { void run(chooseDevice); });
element('device-settings').addEventListener('click', () => { void run(deviceSettings); });
element('logout').addEventListener('click', () => { void run(async () => {
  await request('/auth/logout'); authenticated = false; configuration(); notice('Signed out. The device connection will close shortly.');
}); });
homebridge.addEventListener('configChanged', event => {
  if (!(event instanceof MessageEvent)) return;
  const configs = z.array(configSchema).safeParse(event.data);
  if (configs.success && configs.data[0]) config = configs.data[0];
});
void run(async () => {
  const configs = z.array(z.unknown()).parse(await homebridge.getPluginConfig());
  config = configSchema.parse(configs[0] ?? {});
  authenticated = z.object({ authenticated: z.boolean() }).parse(await request('/status')).authenticated;
  await homebridge.updatePluginConfig([config]);
  configuration();
  notice(authenticated ? 'Signed in. Configure your humidifier below.' : 'Sign in to discover your humidifier.');
});
