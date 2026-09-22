import type { API, Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { Config } from './config.js';
import { DeviceState, fields, modes, type Patch } from './state.js';
import type { DeviceSession } from './session.js';
import { closestColor, controlPosition, controlPositions, nearest, reportedColor } from './controls.js';

type Reader = (state: DeviceState) => CharacteristicValue;
type Writer = (value: CharacteristicValue, state: DeviceState) => Patch | undefined;
interface Binding { characteristic: Characteristic; read: Reader }
export interface SessionControl extends Pick<DeviceSession, 'state' | 'command'> { on(event: 'state', listener: () => void): unknown }

export class HumidifierAccessory {
  private readonly bindings: Binding[] = [];
  private readonly services = new Set<Service>();
  private lastBrightness = 123;
  private poweredBrightness = 123;
  private readonly C: API['hap']['Characteristic'];
  private readonly S: API['hap']['Service'];

  constructor(private readonly api: API, private readonly accessory: PlatformAccessory,
    private readonly config: Config, private readonly session: SessionControl) {
    this.C = api.hap.Characteristic;
    this.S = api.hap.Service;
    const { lastBrightness, poweredBrightness } = accessory.context;
    if (lastBrightness === 115 || lastBrightness === 123) this.lastBrightness = lastBrightness;
    if (poweredBrightness === 0 || poweredBrightness === 115 || poweredBrightness === 123) this.poweredBrightness = poweredBrightness;
    else this.poweredBrightness = this.lastBrightness;
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
  private percent(value: CharacteristicValue): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw this.invalid();
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
      // HAP stores the requested value after onSet returns; then restore the confirmed, rounded value.
      setImmediate(() => this.update());
    });
  }

  private service(type: WithUUID<typeof Service>, name: string, subtype: string): Service {
    const service = this.accessory.getServiceById(type, subtype) ?? this.accessory.addService(new type(name, subtype));
    const previousName = service.getCharacteristic(this.C.Name).value;
    service.addOptionalCharacteristic(this.C.ConfiguredName);
    const configuredName = service.getCharacteristic(this.C.ConfiguredName);
    if (!configuredName.value || previousName !== name) configuredName.updateValue(name);
    configuredName.onSet(value => {
      if (typeof value !== 'string' || !value.trim()) throw this.invalid();
      setImmediate(() => this.api.updatePlatformAccessories([this.accessory]));
    });
    service.setCharacteristic(this.C.Name, name);
    this.services.add(service);
    return service;
  }

  private powerOn(state: DeviceState): Patch {
    return { [fields.power]: 1, ...(!this.value(state, fields.power, 0, 1) && this.config.brightness
      ? { [fields.brightness]: this.poweredBrightness } : {}) };
  }

  private brightness(state: DeviceState): number {
    if (!this.value(state, fields.power, 0, 1)) return 0;
    const raw = state.number(fields.brightness);
    if (raw !== 0 && raw !== 115 && raw !== 123) throw this.unavailable();
    return raw === 123 ? 100 : raw === 115 ? 50 : 0;
  }

  private setup(): void {
    const { C, S } = this;
    const information = this.accessory.getService(S.AccessoryInformation) ?? this.accessory.addService(S.AccessoryInformation);
    this.services.add(information);
    information.setCharacteristic(C.Manufacturer, 'Philips').setCharacteristic(C.Model, String(this.accessory.context.model || 'HU1509/HU1510'))
      .setCharacteristic(C.SerialNumber, this.config.deviceId ?? 'unconfigured');
    const humidifier = this.service(S.HumidifierDehumidifier, this.config.name, 'humidifier');
    humidifier.setPrimaryService(true);
    this.bind(humidifier.getCharacteristic(C.Active), state => this.value(state, fields.power, 0, 1), (value, state) => {
      if (value !== 0 && value !== 1) throw this.invalid();
      return value ? this.powerOn(state) : { [fields.power]: 0 };
    });
    this.bind(humidifier.getCharacteristic(C.CurrentRelativeHumidity), state => this.value(state, fields.humidity, 0, 100));
    this.bind(humidifier.getCharacteristic(C.CurrentHumidifierDehumidifierState), state => {
      if (!this.value(state, fields.power, 0, 1)) return C.CurrentHumidifierDehumidifierState.INACTIVE;
      return this.value(state, fields.mode, 0, 65) === modes.Auto
        && this.value(state, fields.humidity, 0, 100) >= this.value(state, fields.target, 40, 70)
        ? C.CurrentHumidifierDehumidifierState.IDLE : C.CurrentHumidifierDehumidifierState.HUMIDIFYING;
    });
    this.bind(humidifier.getCharacteristic(C.TargetHumidifierDehumidifierState).updateValue(C.TargetHumidifierDehumidifierState.HUMIDIFIER).setProps({ validValues: [C.TargetHumidifierDehumidifierState.HUMIDIFIER] }),
      () => C.TargetHumidifierDehumidifierState.HUMIDIFIER, () => undefined);
    this.bind(humidifier.getCharacteristic(C.RelativeHumidityHumidifierThreshold).setProps({ minValue: 0, maxValue: 100, minStep: 1, validValues: null }), state => {
      const position = controlPosition(this.value(state, fields.power, 0, 1), state.number(fields.mode) ?? -1, state.number(fields.target) ?? -1);
      if (position === undefined) throw this.unavailable();
      return position;
    }, (value, state) => {
      const position = nearest(this.percent(value), controlPositions);
      if (!position) return { [fields.power]: 0 };
      return { ...this.powerOn(state), [fields.mode]: position === 25 ? modes.Medium : position === 100 ? modes.High : modes.Auto,
        ...(position >= 40 && position <= 70 ? { [fields.target]: position } : {}) };
    });
    if (this.config.brightness) this.setupLight();
    if (this.config.temperature) {
      const sensor = this.service(S.TemperatureSensor, this.config.temperatureName, 'temperature');
      this.bind(sensor.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -40, maxValue: 100 }), state => this.value(state, fields.temperature, -400, 1000) / 10);
    }
    if (this.config.humidity) {
      const sensor = this.service(S.HumiditySensor, this.config.humidityName, 'humidity');
      this.bind(sensor.getCharacteristic(C.CurrentRelativeHumidity), state => this.value(state, fields.humidity, 0, 100));
    }
    for (const service of [...this.accessory.services]) if (!this.services.has(service)) this.accessory.removeService(service);
  }

  private setupLight(): void {
    const { C, S } = this;
    const light = this.service(S.Lightbulb, this.config.brightnessName, 'brightness');
    this.bind(light.getCharacteristic(C.On), state => this.brightness(state) > 0, (value, state) => {
      if (typeof value !== 'boolean') throw this.invalid();
      return this.value(state, fields.power, 0, 1) ? { [fields.brightness]: value ? this.lastBrightness : 0 } : undefined;
    });
    this.bind(light.getCharacteristic(C.Brightness).setProps({ minValue: 0, maxValue: 100, minStep: 1, validValues: null }), state => this.brightness(state), (value, state) => {
      const brightness = nearest(this.percent(value), [0, 50, 100]);
      return this.value(state, fields.power, 0, 1) ? { [fields.brightness]: brightness === 100 ? 123 : brightness === 50 ? 115 : 0 } : undefined;
    });
    if (this.config.color) {
      const color = (state: DeviceState) => reportedColor(this.value(state, fields.lamp, 0, 2), this.value(state, fields.ambient, 1, 4));
      this.bind(light.getCharacteristic(C.Hue).setProps({ minValue: 0, maxValue: 360, minStep: 1 }), state => color(state).hue, (value, state) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 360) throw this.invalid();
        return this.value(state, fields.power, 0, 1) ? { [fields.lamp]: 2, [fields.ambient]: closestColor(value).effect } : undefined;
      });
      this.bind(light.getCharacteristic(C.Saturation).setProps({ minValue: 0, maxValue: 100, minStep: 1 }), state => color(state).saturation, value => { this.percent(value); return undefined; });
    } else {
      for (const type of [C.Hue, C.Saturation]) if (light.testCharacteristic(type)) light.removeCharacteristic(light.getCharacteristic(type));
    }
  }

  update(): void {
    const { state } = this.session;
    const brightness = state.number(fields.brightness);
    if (state.available() && state.number(fields.power) === 1 && (brightness === 0 || brightness === 115 || brightness === 123)) {
      this.poweredBrightness = brightness;
      if (brightness) this.lastBrightness = brightness;
      if (this.accessory.context.poweredBrightness !== this.poweredBrightness || this.accessory.context.lastBrightness !== this.lastBrightness) {
        this.accessory.context.poweredBrightness = this.poweredBrightness;
        this.accessory.context.lastBrightness = this.lastBrightness;
        this.api.updatePlatformAccessories([this.accessory]);
      }
    }
    for (const { characteristic, read } of this.bindings) {
      try { characteristic.updateValue(state.available() ? read(state) : this.unavailable()); }
      catch { characteristic.updateValue(this.unavailable()); }
    }
  }
}
