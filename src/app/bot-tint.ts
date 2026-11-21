import type { CSSProperties } from "react";
import type { Bot } from "../shared/types";

const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The color an assistant's chat is tinted with: its drawn avatar's color. Photos keep the app's green. */
export function botTint(bot?: Bot): string | undefined {
  const avatar = bot?.avatar;
  return avatar && avatar.mode !== "portrait" && hex.test(avatar.color) ? avatar.color : undefined;
}

/** Props that tint a chat's surfaces; the CSS derives readable washes from the one color. */
export function tintProps(bot?: Bot): { "data-tint"?: string; style?: CSSProperties } {
  const tint = botTint(bot);
  if (!tint) return {};
  return {
    "data-tint": "",
    style: { ["--bot-tint" as string]: tint, ["--solid-fill" as string]: solidFill(tint) },
  };
}

function channels(color: string): [number, number, number] | undefined {
  if (!hex.test(color)) return undefined;
  let digits = color.slice(1);
  if (digits.length === 3) digits = digits.replace(/./g, "$&$&");
  const value = Number.parseInt(digits, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encoded = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Björn Ottosson's OKLab from sRGB channels in 0...1. */
function oklab(red: number, green: number, blue: number) {
  const r = linear(red);
  const g = linear(green);
  const b = linear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Linear sRGB channels, which fall outside 0...1 for a color sRGB cannot show. */
function linearRgb(lightness: number, a: number, b: number): [number, number, number] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (lightness: number, a: number, b: number) =>
  linearRgb(lightness, a, b).every((c) => c >= -1e-6 && c <= 1 + 1e-6);

/** The most chroma, at most `chroma`, that sRGB shows at this lightness and hue. */
function largestChromaInGamut(lightness: number, hue: number, chroma: number): number {
  if (inGamut(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue))) return chroma;
  let low = 0;
  let high = chroma;
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (inGamut(lightness, middle * Math.cos(hue), middle * Math.sin(hue))) low = middle;
    else high = middle;
  }
  return low;
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255);
}

/** The highest OKLCH lightness a solid fill may have, so white text on it keeps 4.5:1. */
const lightnessCap = 0.52;

/**
 * A person's solid bubble fill for an assistant color, as "#RRGGBB": the color with its OKLCH lightness capped,
 * its hue kept, and its chroma reduced only as far as sRGB needs. Should rounding land white text a hair under
 * 4.5:1, the lightness steps down until it reaches it. This mirrors `SolidBubble.fill` on iOS step for step, and
 * both clients' tests read the same vectors, so the two show one color.
 */
export function solidFill(color: string): string | undefined {
  const rgb = channels(color);
  if (!rgb) return undefined;
  const lab = oklab(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
  const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  const hue = Math.atan2(lab.b, lab.a);
  let lightness = Math.min(lab.l, lightnessCap);
  for (;;) {
    const fitted = largestChromaInGamut(lightness, hue, chroma);
    const bytes = linearRgb(lightness, fitted * Math.cos(hue), fitted * Math.sin(hue)).map((c) =>
      Math.round(encoded(Math.min(Math.max(c, 0), 1)) * 255),
    ) as [number, number, number];
    if (1.05 / (luminance(bytes) + 0.05) >= 4.5 || lightness <= 0) {
      return `#${bytes.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
    }
    lightness = Math.max(0, lightness - 0.005);
  }
}
