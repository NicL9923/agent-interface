// Writes the iOS provider marks from the web's path data, so the two cannot drift:
//   node --import tsx ios/tools/sync-provider-icons.mjs
// tests/provider-icon.test.ts fails when an image in the asset catalog differs from src/shared/provider-icon.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerIconPaths } from "../../src/shared/provider-icon.ts";

export const catalog = new URL("../AgentInterface/Assets.xcassets/ProviderIcons/", import.meta.url).pathname;
export const svg = path => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${path}"/></svg>\n`;
export const contents = name => JSON.stringify({
  images: [{ filename: `${name}.svg`, idiom: "universal" }],
  info: { author: "xcode", version: 1 },
  properties: { "preserves-vector-representation": true, "template-rendering-intent": "template" },
}, null, 2) + "\n";

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(catalog, { recursive: true });
  writeFileSync(join(catalog, "Contents.json"), JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n");
  for (const [key, path] of Object.entries(providerIconPaths)) {
    const name = `provider-${key}`, directory = join(catalog, `${name}.imageset`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.svg`), svg(path));
    writeFileSync(join(directory, "Contents.json"), contents(name));
  }
}
