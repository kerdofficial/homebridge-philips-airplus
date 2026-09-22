import { effects, modes } from './state.js';

export const controlPositions = [0, 25, 40, 50, 60, 70, 100] as const;
export const colorPresets = {
  Warm: { hue: 48, saturation: 65, effect: effects.Warm },
  Dawn: { hue: 25, saturation: 75, effect: effects.Dawn },
  Calm: { hue: 190, saturation: 20, effect: effects.Calm },
} as const;

export function nearest(value: number, choices: readonly number[]): number {
  return choices.reduce((a, b) => Math.abs(b - value) < Math.abs(a - value) ? b : a);
}

export function controlPosition(power: number, mode: number, target: number): number | undefined {
  if (power === 0) return 0;
  if (mode === modes.Medium || mode === modes.Sleep) return 25;
  if (mode === modes.High) return 100;
  if (mode === modes.Auto && [40, 50, 60, 70].includes(target)) return target;
  return undefined;
}

export function closestColor(hue: number) {
  const distance = (candidate: number) => {
    const difference = Math.abs(candidate - hue % 360);
    return Math.min(difference, 360 - difference);
  };
  return Object.values(colorPresets).reduce((a, b) => distance(b.hue) < distance(a.hue) ? b : a);
}

export function reportedColor(lamp: number, effect: number) {
  return (lamp === 2 ? Object.values(colorPresets).find(color => color.effect === effect) : undefined)
    ?? { hue: 0, saturation: 0 };
}
