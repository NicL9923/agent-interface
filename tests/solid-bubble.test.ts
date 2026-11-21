import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { solidFill } from "../src/app/bot-tint";
import { avatarColors } from "../src/components/Avatar";

// The iOS SolidBubble.fill test reads the same vectors, so both clients fill a person's bubble with one color.
const file = fileURLToPath(
  new URL("../ios/AgentInterfaceTests/Vectors/solid-bubble.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(file, "utf8")) as {
  cases: { name: string; color: string; fill: string | null }[];
};

const linear = (byte: number) => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
function whiteContrast(color: string): number {
  const value = Number.parseInt(color.slice(1), 16);
  const y =
    0.2126 * linear((value >> 16) & 255) +
    0.7152 * linear((value >> 8) & 255) +
    0.0722 * linear(value & 255);
  return 1.05 / (y + 0.05);
}

describe("solidFill", () => {
  it.each(vectors.cases)("$name", ({ color, fill }) => {
    const result = solidFill(color);
    expect(result ?? null).toBe(fill);
    if (result) expect(whiteContrast(result)).toBeGreaterThanOrEqual(4.5);
  });

  it("has a vector for every avatar color", () => {
    const covered = new Set(vectors.cases.map((vector) => vector.color));
    expect(avatarColors.filter((color) => !covered.has(color))).toEqual([]);
  });
});
