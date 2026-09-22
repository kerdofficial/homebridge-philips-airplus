import type { API, Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { Config } from './config.js';
import { DeviceState, effects, fields, modes, type Patch } from './state.js';
import type { DeviceSession } from './session.js';

type Reader = (state: DeviceState) => CharacteristicValue;
type Writer = (value: CharacteristicValue, state: DeviceState) => Patch | undefined;
interface Binding { characteristic: Characteristic; read: Reader }
export interface SessionControl extends Pick<DeviceSession, 'state' | 'command'> { on(event: 'state', listener: () => void): unknown }

export class HumidifierAccessory {
  private readonly bindings: Binding[] = [];
  private readonly services = new Set<Service>();
  private lastBrightness = 123;
  private readonly C: API['hap']['Characteristic'];
  private readonly S: API['hap']['Service'];

  constructor(private readonly api: API, private readonly accessory: PlatformAccessory,
    private readonly config: Config, private readonly session: SessionControl) {
    this.C = api.hap.Characteristic;
    this.S = api.hap.Service;
    if ([115, 123].includes(accessory.context.lastBrightness)) this.lastBrightness = accessory.context.lastBrightness;
    this.setup();
    session.on('state', () => this.update());
    this.update();
  }

  private unavailable(): Error { const hap = this.api.hap; return new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
  private invalid(): Error { const hap = this.api.hap; return new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST); }
  private value(state: DeviceState, key: string, min: number, max: number): number {
    const value = state.number(key);
    if (value === undefined || value < min || value > max) throw this.unavailable();
    return value;
  }
  private bind(characteristic: Characteristic, read: Reader, write?: Writer): void {
    this.bindings.push({ characteristic, read });
    characteristic.onGet(() => {
      if (!this.session.state.available()) throw this.unavailable();
      return read(this.session.state);
    });
    if (write) characteristic.onSet(async value => {
      try { await this.session.command(state => write(value, state)); }
      catch { throw this.unavailable(); }
    });
  }

  private service(type: WithUUID<typeof Service>, name: string, subtype: string): Service {
    const service = this.accessory.getServiceById(type, subtype) ?? this.accessory.addService(new type(name, subtype));
    service.setCharacteristic(this.C.Name, name);
    this.services.add(service);
    return service;
  }

  private switch(name: string, subtype: string, read: (state: DeviceState) => boolean, on: Writer, off: Writer): void {
    const service = this.service(this.S.Switch, name, subtype);
    this.bind(service.getCharacteristic(this.C.On), read, (value, state) => {
      if (typeof value !== 'boolean') throw this.invalid();
      if (value) return on(value, state);
      return read(state) ? off(value, state) : undefined;
    });
  }

  private setup(): void {
    const { C, S } = this;
    const information = this.accessory.getService(S.AccessoryInformation) ?? this.accessory.addService(S.AccessoryInformation);
    this.services.add(information);
    information.setCharacteristic(C.Manufacturer, 'Philips').setCharacteristic(C.Model, String(this.accessory.context.model || 'HU1509/HU1510'))
      .setCharacteristic(C.SerialNumber, this.config.deviceId ?? 'unconfigured');
    const humidifier = this.service(S.HumidifierDehumidifier, this.config.name, 'humidifier');
    humidifier.setPrimaryService(true);
    this.bind(humidifier.getCharacteristic(C.Active), state => this.value(state, fields.power, 0, 1), value => {
      if (value !== 0 && value !== 1) throw this.invalid();
      return { [fields.power]: value };
    });
    this.bind(humidifier.getCharacteristic(C.CurrentRelativeHumidity), state => this.value(state, fields.humidity, 0, 100));
    this.bind(humidifier.getCharacteristic(C.CurrentHumidifierDehumidifierState), state => {
      if (!this.value(state, fields.power, 0, 1)) return C.CurrentHumidifierDehumidifierState.INACTIVE;
      return this.value(state, fields.humidity, 0, 100) >= this.value(state, fields.target, 40, 70)
        ? C.CurrentHumidifierDehumidifierState.IDLE : C.CurrentHumidifierDehumidifierState.HUMIDIFYING;
    });
    this.bind(humidifier.getCharacteristic(C.TargetHumidifierDehumidifierState).setProps({ validValues: [C.TargetHumidifierDehumidifierState.HUMIDIFIER] }),
      () => C.TargetHumidifierDehumidifierState.HUMIDIFIER, () => undefined);
    this.bind(humidifier.getCharacteristic(C.RelativeHumidityHumidifierThreshold).setProps({ minValue: 40, maxValue: 70, minStep: 10 }),
      state => this.value(state, fields.target, 40, 70), value => {
        if (typeof value !== 'number' || ![40, 50, 60, 70].includes(value)) throw this.invalid();
        return { [fields.target]: value };
      });
    if (this.config.temperature) {
      const sensor = this.service(S.TemperatureSensor, this.config.temperatureName, 'temperature');
      this.bind(sensor.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -40, maxValue: 100 }), state => this.value(state, fields.temperature, -400, 1000) / 10);
    }
    if (this.config.humidity) {
      const sensor = this.service(S.HumiditySensor, this.config.humidityName, 'humidity');
      this.bind(sensor.getCharacteristic(C.CurrentRelativeHumidity), state => this.value(state, fields.humidity, 0, 100));
    }
    if (this.config.modes) for (const [name, mode] of Object.entries(modes)) {
      this.switch(name, `mode-${name.toLowerCase()}`, state => state.number(fields.power) === 1 && state.number(fields.mode) === mode,
        () => ({ [fields.power]: 1, [fields.mode]: mode }), () => ({ [fields.power]: 0 }));
    }
    if (this.config.lampModes) {
      this.switch('Humidity light', 'lamp-humidity', state => state.number(fields.lamp) === 1,
        () => ({ [fields.lamp]: 1 }), () => ({ [fields.lamp]: 0 }));
      this.switch('Ambient light', 'lamp-ambient', state => state.number(fields.lamp) === 2,
        (_value, state) => ({ [fields.lamp]: 2, [fields.ambient]: [1, 2, 3, 4].includes(state.number(fields.ambient) ?? 0) ? state.number(fields.ambient)! : 1 }),
        () => ({ [fields.lamp]: 0 }));
    }
    if (this.config.effects) for (const [name, effect] of Object.entries(effects)) {
      this.switch(name, `effect-${name.toLowerCase()}`, state => state.number(fields.lamp) === 2 && state.number(fields.ambient) === effect,
        () => ({ [fields.lamp]: 2, [fields.ambient]: effect }), () => ({ [fields.lamp]: 0 }));
    }
    if (this.config.brightness) {
      const light = this.service(S.Lightbulb, 'Brightness', 'brightness');
      this.bind(light.getCharacteristic(C.On), state => this.value(state, fields.brightness, 0, 123) !== 0,
        value => ({ [fields.brightness]: value ? this.lastBrightness : 0 }));
      this.bind(light.getCharacteristic(C.Brightness).setProps({ minValue: 0, maxValue: 100, minStep: 50 }), state => {
        const raw = state.number(fields.brightness);
        if (![0, 115, 123].includes(raw ?? -1)) throw this.unavailable();
        return raw === 123 ? 100 : raw === 115 ? 50 : 0;
      }, value => {
        if (typeof value !== 'number' || value < 0 || value > 100) throw this.invalid();
        return { [fields.brightness]: value < 25 ? 0 : value < 75 ? 115 : 123 };
      });
    }
    if (this.config.timers) for (const hours of this.config.timerHours) {
      this.switch(`Timer ${hours} ${hours === 1 ? 'hour' : 'hours'}`, `timer-${hours}`, state => state.number(fields.timer) === hours + 1,
        () => ({ [fields.timer]: hours + 1 }), () => ({ [fields.timer]: 0 }));
    }
    for (const [enabled, name, subtype, field] of [
      [this.config.beep, 'Beep', 'beep', fields.beep], [this.config.standby, 'Standby sensors', 'standby', fields.standby],
    ] as const) if (enabled) {
      this.switch(name, subtype, state => state.number(field) === 1, () => ({ [field]: 1 }), () => ({ [field]: 0 }));
    }
    for (const service of [...this.accessory.services]) if (!this.services.has(service)) this.accessory.removeService(service);
  }

  update(): void {
    const { state } = this.session;
    const brightness = state.number(fields.brightness);
    if (brightness === 115 || brightness === 123) {
      if (this.lastBrightness !== brightness || this.accessory.context.lastBrightness !== brightness) {
        this.lastBrightness = brightness;
        this.accessory.context.lastBrightness = brightness;
        this.api.updatePlatformAccessories([this.accessory]);
      }
    }
    for (const { characteristic, read } of this.bindings) {
      try { characteristic.updateValue(state.available() ? read(state) : this.unavailable()); }
      catch { characteristic.updateValue(this.unavailable()); }
    }
  }
}
