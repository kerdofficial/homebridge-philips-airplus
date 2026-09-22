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

## Apple Home controls

The accessory combines a humidifier control, an optional light, and optional temperature and humidity sensors. There are no mode switches or TV accessories. Apple Home determines the visual order and presentation.

The main slider is a combined mode and humidity control:

| Slider position | Device setting |
| --- | --- |
| 0 | Off |
| 25 | Medium |
| 40, 50, 60, 70 | Auto with that target humidity |
| 100 | High |

The Home app labels this slider as a humidity percentage. Positions 25 and 100 select modes, not actual humidity targets. The separate humidity sensor always shows measured humidity. Sleep is not selectable on this slider; when selected in Air+, it is represented at the low manual position, 25. Moving the slider to 25 selects Medium.

Every value from 0 to 100 is accepted and rounded to the nearest supported position; ties select the lower position. In particular, Home requests of 20 or 30 select Medium instead of causing a communication error. Changing the slider to a nonzero position powers on the device. The Off/Humidify menu changes power without replacing the last mode.

The light brightness slider accepts the same continuous input range and rounds to 0% Off, 50% Low or 100% Bright, with ties selecting the lower level. While the humidifier is off, the light reports Off and 0%; light commands have no effect and do not power on the humidifier. Powering on restores the last known brightness used while powered on, including Off. Turning just the light on restores its last nonzero brightness, defaulting to Bright if unknown. Home does not visually disable the light controls while the humidifier is off.

Optional color selection uses Home's native hue and saturation controls. Hue chooses the nearest of these representative colors and enables Ambient mode:

| Representative color | Philips effect |
| --- | --- |
| Yellow | Warm |
| Orange | Dawn |
| Pale blue | Calm |

These are fixed device effects, not arbitrary RGB output. Saturation returns to the preset's value. The selected hue and saturation are representative UI values, not calibrated measurements of emitted light. Breath, Humidity light and lamp-off states selected in Air+ use a neutral color indicator; the plugin does not claim they are one of the three fixed effects. They are not selectable through this color control. Color changes do not change brightness or turn on the humidifier.

Humidifying versus idle is inferred from power, mode and the measured humidity/target relationship, not from an independent atomizer sensor. No air-pollution or water-level measurement is fabricated.

## Device settings in Homebridge

Open **Device settings** in the plugin UI to read the current sleep timer, sound feedback and standby sensor settings. Choose the setting to change and apply it; other settings are preserved. The timer supports Off or 1-12 hours and controls the device's own timer. Responses wait for a reported device confirmation.

These settings are not Home switches, stored schedules or startup defaults. Restarting Homebridge does not apply them. Use Air+ for Sleep, Breath and other controls not exposed by this version.

## Connection and privacy

The plugin uses a persistent MQTT connection and refreshes connection credentials on reconnect. It merges reported updates and rejects older versions. Commands are serialized and are successful only after a newer reported state confirms the requested values. HomeKit requests time out after eight seconds; a late device report still updates the displayed state. Commands are not blindly retried or replayed after restarting.

A cloud response is not proof of a fresh measurement. Disconnected devices, explicitly offline devices and measurements without a device timestamp from the past ten minutes are unavailable in Home. An unchanged device that does not send fresh telemetry can therefore appear unavailable until it reports again.

Credentials are stored under `philips-airplus/credentials.json` in Homebridge's storage directory, outside the plugin source. The file is written with owner-only permissions. Protect the Homebridge storage directory and its backups. Secrets are not returned to the settings page and raw cloud errors are not logged. Signing out removes the saved credentials and closes the running device session shortly afterward. Reauthentication and configuration changes should be followed by a child bridge restart.

## Configuration

The plugin uses Homebridge's native schema form for configuration and its native generated forms for sign-in, device selection and one-time device settings. There is no separate control website or custom-styled settings page. The small UI integration keeps sign-in credentials out of the platform configuration. Its fields are:

- `platform`: `PhilipsAirPlus`
- `deviceId`: the explicitly selected cloud device ID
- `name`, `temperatureName`, `humidityName`, `brightnessName`: display names
- `temperature`, `humidity`, `brightness`: service visibility, all enabled by default
- `color`: native color selection when the light service is enabled, enabled by default

Credentials are never placed in this configuration. The plugin preserves Homebridge-managed properties such as `_bridge` when saving. Retired switch configuration fields are discarded. Upgrading from the earlier switch layout removes those switches while retaining the accessory and surviving service identifiers; automations using removed switches must be recreated. Existing Home-assigned names are retained unless their configured default changes.

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
