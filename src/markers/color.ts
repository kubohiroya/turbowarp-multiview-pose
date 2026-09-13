export interface Hsv {
  hue: number;
  saturation: number;
  value: number;
}

/** Parses `#RRGGBB`, rejecting every other spelling. */
export function parseHexColor(
  value: string,
): { r: number; g: number; b: number } | undefined {
  if (!/^#[0-9A-Fa-f]{6}$/u.test(value)) return undefined;
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

export function hexFromRgb(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(toHexByte).join("")}`;
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta + 6) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  return { hue, saturation: max === 0 ? 0 : delta / max, value: max };
}

export function hsvFromHex(value: string): Hsv | undefined {
  const rgb = parseHexColor(value);
  return rgb ? rgbToHsv(rgb.r, rgb.g, rgb.b) : undefined;
}

/** Shortest distance between two hues in degrees. */
export function hueDistance(first: number, second: number): number {
  const difference = Math.abs(first - second) % 360;
  return difference > 180 ? 360 - difference : difference;
}

function toHexByte(value: number): string {
  const clamped = Math.min(Math.max(Math.round(value), 0), 255);
  return clamped.toString(16).padStart(2, "0");
}
