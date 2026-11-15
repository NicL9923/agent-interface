import type { Page } from "@playwright/test";
import { assistants, conversation, expect, signIn, test, uploadedFiles } from "./fixtures.js";

/**
 * A phone photo in real Chromium: it decodes, rotates and encodes through the browser's own codecs, which jsdom
 * has none of. The photo is generated here, 4000 by 3000 with a red square in its top-left corner, and tagged with
 * EXIF orientation 6, as a phone held upright tags a sensor that is wider than tall.
 */
async function photo(page: Page, { width = 4000, height = 3000, detail = 9000 } = {}) {
  const jpeg = await page.evaluate(async ([width, height, detail]) => {
    const canvas = document.createElement("canvas");
    canvas.width = width!; canvas.height = height!;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, width!, height!);
    gradient.addColorStop(0, "#1e3a5f"); gradient.addColorStop(1, "#7fb069");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width!, height!);
    // Detail a JPEG cannot squeeze away, so the file is the size a phone's is: several MB.
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let index = 0; index < detail!; index += 1) {
      context.fillStyle = `rgb(${random() * 120 | 0}, ${random() * 255 | 0}, ${random() * 255 | 0})`;
      context.fillRect(random() * width!, random() * height!, 8 + random() * 60, 8 + random() * 60);
    }
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, Math.round(width! / 10), Math.round(width! / 10));
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/jpeg", 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
    return btoa(binary);
  }, [width, height, detail]);
  const bytes = Buffer.from(jpeg, "base64");
  // APP1 "Exif" holding one IFD entry, Orientation (0x0112) = 6: display the picture rotated 90 degrees clockwise.
  const exif = Buffer.alloc(36);
  exif.writeUInt16BE(0xffe1, 0); exif.writeUInt16BE(34, 2); exif.write("Exif", 4, "latin1");
  exif.writeUInt16BE(0x4d4d, 10); exif.writeUInt16BE(0x002a, 12); exif.writeUInt32BE(8, 14);
  exif.writeUInt16BE(1, 18); exif.writeUInt16BE(0x0112, 20); exif.writeUInt16BE(3, 22); exif.writeUInt32BE(1, 24); exif.writeUInt16BE(6, 28);
  return Buffer.concat([bytes.subarray(0, 2), exif, bytes.subarray(2)]);
}

/** What the browser itself decodes the uploaded bytes to: its size, and the color at a point. */
const decoded = (page: Page, base64: string, mime: string, at: [number, number]) => page.evaluate(async ([base64, mime, at]) => {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64 as string), char => char.charCodeAt(0))], { type: mime as string }), { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  const [x, y] = at as number[];
  const [r, g, b] = context.getImageData(x!, y!, 1, 1).data;
  return { width: bitmap.width, height: bitmap.height, color: [r!, g!, b!] };
}, [base64, mime, at]);

async function openAssistant(page: Page) {
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
}
const picker = (page: Page) => page.locator('input[type="file"]');

test("a phone photo uploads at 2048 px, upright, in a fraction of its size", async ({ page }) => {
  await openAssistant(page);
  const original = await photo(page);
  expect(original.length).toBeGreaterThan(2_000_000);
  await picker(page).setInputFiles({ name: "IMG_4242.JPG", mimeType: "image/jpeg", buffer: original });
  await expect.poll(async () => (await uploadedFiles()).length).toBe(1);

  const [sent] = await uploadedFiles();
  expect([sent!.name, sent!.mime]).toEqual(["IMG_4242.webp", "image/webp"]);
  expect(Buffer.from(sent!.base64, "base64").length).toBeLessThan(original.length / 3);
  // The tag said 90 degrees clockwise, so the upright photo is 3000 by 4000 and shrinks to 1536 by 2048, and its red
  // corner moved from the top-left to the top-right.
  const topRight = await decoded(page, sent!.base64, sent!.mime, [1536 - 20, 20]);
  expect([topRight.width, topRight.height]).toEqual([1536, 2048]);
  expect(topRight.color[0]).toBeGreaterThan(200);
  expect(topRight.color[1]).toBeLessThan(80);
  expect((await decoded(page, sent!.base64, sent!.mime, [20, 20])).color[0]).toBeLessThan(120);
  // The chip in the message box shows the shrunk file, under its new name.
  await expect(page.getByRole("button", { name: "Preview IMG_4242.webp" })).toBeVisible();
});

test("an image the server takes whole is left alone: a small photo, a GIF, and a PNG screenshot", async ({ page }) => {
  await openAssistant(page);
  // A GIF's header, one pixel, and 1.5 MB of comment blocks: large, and valid.
  const comment = Buffer.concat([Buffer.from([0x21, 0xfe, 255]), Buffer.alloc(255, 0x61), Buffer.from([0])]);
  const gif = Buffer.concat([
    Buffer.from("47494638396101000100800000000000ffffff", "hex"),
    ...Array<Buffer>(6000).fill(comment),
    Buffer.from("2c00000000010001000002024401003b", "hex"),
  ]);
  const small = await photo(page, { width: 400, height: 300, detail: 10 });
  const screenshot = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 900;
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(900, 900);
    // Noise, so the PNG is over 1 MB and a re-encode would have shrunk it.
    let state = 12345;
    for (let at = 0; at < pixels.data.length; at += 1) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      pixels.data[at] = at % 4 === 3 ? 255 : state & 255;
    }
    context.putImageData(pixels, 0, 0);
    const bytes = new Uint8Array(await (await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"))).arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
    return btoa(binary);
  }), "base64");
  expect(small.length).toBeLessThan(1024 * 1024);
  expect(screenshot.length).toBeGreaterThan(1024 * 1024);
  expect(gif.length).toBeGreaterThan(1024 * 1024);
  const files = [
    { name: "small.jpg", mimeType: "image/jpeg", buffer: small },
    { name: "loop.gif", mimeType: "image/gif", buffer: gif },
    { name: "Screenshot.png", mimeType: "image/png", buffer: screenshot },
  ];
  await picker(page).setInputFiles(files);
  await expect.poll(async () => (await uploadedFiles()).length).toBe(3);
  const sent = await uploadedFiles();
  expect(sent.map(file => [file.name, file.mime, file.base64])).toEqual(files.map(file => [file.name, file.mimeType, file.buffer.toString("base64")]));
});

test("a HEIC photo the browser cannot decode is refused with the reason, and nothing uploads", async ({ page }) => {
  await openAssistant(page);
  // Not a decodable picture in any browser, which is what an unsupported codec looks like to the page.
  await picker(page).setInputFiles({ name: "IMG_0001.HEIC", mimeType: "image/heic", buffer: Buffer.from("not a picture") });
  await expect(page.getByRole("alert").filter({ hasText: "IMG_0001.HEIC is a HEIC photo, and this browser can't open it." })).toBeVisible();
  await expect(page.getByRole("list", { name: "Attachments" })).toHaveCount(0);
  expect(await uploadedFiles()).toEqual([]);
});
