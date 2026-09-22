# Homebridge Philips Air+

A Homebridge plugin for Philips Air+ HU1509 and HU1510 humidifiers using the MxChip/FogCloud service. It exposes the humidifier, temperature, humidity and optional controls in Apple Home.

This is an unofficial integration. It requires an internet connection and a compatible Philips cloud account. Other models and the Versuni/DaConnect backend are not supported.

## Requirements

- Node.js 22.10 or newer in the 22.x line, or Node.js 24.x
- Homebridge 1.8+ or 2.x with Homebridge UI
- A Philips account with a supported humidifier
- The Air+ MxChip application signing key, supplied separately at setup

The signing key is an application-level credential, not your Philips password. It is intentionally not distributed in this repository. Obtain it from a compatible Air+ client configuration; protocol references are listed below. A Philips password is not needed for email-code sign-in.

## Build and install

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

Install the resulting package on the Homebridge host using its custom package installation flow or the package manager used by that Homebridge installation. For a global npm-managed installation:

```sh
npm install -g /path/to/homebridge-philips-airplus-0.1.0.tgz
```

Restart Homebridge so it discovers the plugin. Open the plugin settings:

1. Enter the application signing key and Philips account email.
2. Request and enter the six-digit email code.
3. Explicitly select a supported humidifier.
4. Set the accessory and sensor names and choose the controls to expose.
5. Save, enable a dedicated child bridge in Homebridge UI, and restart that child bridge.
6. Pair the child bridge with Apple Home.

One platform configuration selects one device. The plugin does not automatically expose every device in the account. Renaming preserves the accessory identity. Removing services can affect automations that refer to them.

## Controls

| Service | Behavior |
| --- | --- |
| Humidifier | Power and a target humidity of 40, 50, 60 or 70 percent |
| Temperature | Temperature in degrees Celsius |
| Humidity | Relative humidity in percent |
| Auto, Sleep, Medium, High | Turning on selects the mode and powers on; turning off the active mode powers off |
| Humidity light, Ambient light | Select the lamp mode; turning off the active mode disables the lamp |
| Warm, Dawn, Calm, Breath | Select an effect and enable Ambient mode; turning off the active effect disables the lamp |
| Brightness | A separate light control: 0% off, 50% low, 100% bright |
| Timer | Selected durations from 1 to 12 hours; turning off the active duration cancels the timer |
| Beep | Sound feedback on or off |
| Standby sensors | Sensor operation while the humidifier is in standby |

Turning off an inactive selector has no effect. Brightness is independent of ambient effect selection. Intermediate brightness requests round to the nearest supported level, with ties rounding upward. Turning brightness on restores its previous nonzero level, or Bright if no level is known.

Ambient mode retains the device's known effect, defaulting to Warm when unknown. Lighting, target humidity and timer commands do not implicitly power on the humidifier.

Sensors, modes and lighting are enabled by default. Timers, Beep and Standby sensors are optional. Enabling timers defaults to 1, 2 and 4 hours; select other durations in the settings. Timer switches represent the selected duration, not a countdown. A timer selected in Air+ for a hidden duration will not have an active matching switch in Home; enable that duration to expose it.

The Apple Home app determines the layout of these standard services. It does not provide arbitrary Philips-specific dropdowns. The humidifying/idle indication is inferred from power, current humidity and target humidity; it is not an independently measured atomizer state. No air-pollution or water-level measurement is fabricated.

## Connection and privacy

The plugin uses a persistent MQTT connection and refreshes connection credentials on reconnect. It merges reported updates and rejects older versions. Commands are serialized and are successful only after a newer reported state confirms the requested values. HomeKit requests time out after eight seconds; a late device report still updates the displayed state. Commands are not blindly retried or replayed after restarting.

A cloud response is not proof of a fresh measurement. Disconnected devices, explicitly offline devices and measurements without a device timestamp from the past ten minutes are unavailable in Home. An unchanged device that does not send fresh telemetry can therefore appear unavailable until it reports again.

Credentials are stored under `philips-airplus/credentials.json` in Homebridge's storage directory, outside the plugin source. The file is written with owner-only permissions. Protect the Homebridge storage directory and its backups. Secrets are not returned to the settings page and raw cloud errors are not logged. Signing out removes the saved credentials and closes the running device session shortly afterward. Reauthentication and configuration changes should be followed by a child bridge restart.

## Configuration

The custom UI generates the platform configuration. Its fields are:

- `platform`: `PhilipsAirPlus`
- `deviceId`: the explicitly selected cloud device ID
- `name`, `temperatureName`, `humidityName`: display names
- `temperature`, `humidity`, `modes`, `lampModes`, `effects`, `brightness`, `timers`, `beep`, `standby`: service visibility
- `timerHours`: selected whole hours between 1 and 12

Credentials are never placed in this configuration. The plugin preserves Homebridge-managed properties such as `_bridge` when saving.

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit:package
```

Tests use synthetic state and mocked cloud responses. Keep account data, real device identifiers, credentials, captures and research output outside the repository. The package allowlist excludes tests and development artifacts. GitHub and npm publishing are not automated.

## References

- [Homebridge plugin template](https://github.com/homebridge/homebridge-plugin-template)
- [Homebridge plugin UI utilities](https://github.com/homebridge/plugin-ui-utils)
- [Philips Air platform service layout](https://github.com/seydx/homebridge-philipsair-platform)
- [Philips Air+ cloud protocol reference](https://github.com/kwesolowski/node-red-contrib-philips-airplus)
- [Philips Air+ Python integration](https://github.com/Ka3seBr0t/HA_Philips_Air_Plus)

The plugin implements its own TypeScript client and does not require a Python installation.

## License

MIT. See [LICENSE](LICENSE).
