// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_PORTRAIT_INPUT_BYTES, PORTRAIT_INPUT_ERROR, preparePortrait } from "../src/portrait-upload";

const drawImage = vi.fn();
let blob: Blob | null;
let canvas: HTMLCanvasElement;
let decodeFails = false;
beforeEach(() => {
  blob = new Blob(["compressed"], { type: "image/png" });
  decodeFails = false;
  vi.stubGlobal("Image", class {
    naturalWidth = 6000;
    naturalHeight = 4000;
    onload!: () => void;
    onerror!: () => void;
    set src(_value: string) { queueMicrotask(() => decodeFails ? this.onerror() : this.onload()); }
  });
  URL.createObjectURL = vi.fn(() => "blob:portrait");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    canvas = this;
    return { drawImage } as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(blob));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("accepts 15 MB and resizes before uploading a PNG under the storage limit", async () => {
  const file = await preparePortrait(new File([new Uint8Array(MAX_PORTRAIT_INPUT_BYTES)], "photo.jpg", { type: "image/jpeg" }));
  expect([canvas.width, canvas.height]).toEqual([512, 341]);
  expect(drawImage).toHaveBeenCalled();
  expect(file.type).toBe("image/png");
  expect(file.size).toBe(blob!.size);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:portrait");
});
it.each([
  new File([new Uint8Array(MAX_PORTRAIT_INPUT_BYTES + 1)], "large.png", { type: "image/png" }),
  new File(["text"], "file.txt", { type: "text/plain" }),
])("rejects invalid input before decoding", async file => {
  await expect(preparePortrait(file)).rejects.toThrow(PORTRAIT_INPUT_ERROR);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it("reports decode errors and releases the object URL", async () => {
  decodeFails = true;
  await expect(preparePortrait(new File(["bad"], "bad.png", { type: "image/png" }))).rejects.toThrow("couldn't be read");
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});
it.each([null, new Blob([new Uint8Array(2_000_001)])])("does not upload failed or oversized canvas output", async result => {
  blob = result;
  await expect(preparePortrait(new File(["image"], "image.png", { type: "image/png" }))).rejects.toThrow("couldn't be compressed");
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});
