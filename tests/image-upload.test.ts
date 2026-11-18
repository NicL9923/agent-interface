// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BYTES } from "../src/shared/uploads";
import { IMAGE_QUALITY, KEEP_UNDER_BYTES, MAX_IMAGE_EDGE } from "../src/image-upload";

const file = (name: string, type: string, size = 4) =>
  new File([new Uint8Array(size)], name, { type });

let image: typeof import("../src/image-upload");
beforeEach(async () => {
  // The module remembers whether this browser encodes WebP, so each test starts it fresh.
  vi.resetModules();
  image = await import("../src/image-upload");
});

describe("which format a file claims", () => {
  it.each([
    ["IMG_1.jpg", "image/jpeg", "jpeg"],
    ["a.webp", "image/webp; charset=x", "webp"],
    ["a.png", "IMAGE/PNG", "png"],
    ["a.gif", "image/gif", "gif"],
    ["IMG_1.HEIC", "image/heic", "heic"],
    ["IMG_1.heif", "image/heif", "heic"],
    // Windows names no type for HEIC, so the extension decides, but only when the system gave no type.
    ["IMG_1.HEIC", "", "heic"],
    ["IMG_1.heif", "application/octet-stream", "heic"],
    ["IMG_1.heic", "image/png", "png"],
    ["IMG_1.heic", "application/pdf", undefined],
    ["notes.txt", "text/plain", undefined],
    ["IMG_1.tiff", "image/tiff", undefined],
    ["heic", "", undefined],
  ])("%s as %s is %s", (name, type, kind) => expect(image.imageKind({ name, type })).toBe(kind));
});

describe("which images are shrunk", () => {
  it.each([
    ["a JPEG under 1 MB uploads as it is", "image/jpeg", KEEP_UNDER_BYTES - 1, false],
    ["a JPEG from 1 MB up is shrunk", "image/jpeg", KEEP_UNDER_BYTES, true],
    ["a WebP under 1 MB uploads as it is", "image/webp", 10, false],
    ["a WebP from 1 MB up is shrunk", "image/webp", KEEP_UNDER_BYTES, true],
    ["a large GIF keeps its animation", "image/gif", MAX_UPLOAD_BYTES, false],
    ["a large PNG screenshot stays sharp", "image/png", MAX_UPLOAD_BYTES, false],
    ["a tiny HEIC is converted, since the server cannot take it", "image/heic", 10, true],
    ["a PDF is not an image", "application/pdf", MAX_UPLOAD_BYTES, false],
  ])("%s", (_name, type, size, expected) =>
    expect(image.needsPreparation(file("x", type, size))).toBe(expected),
  );
});

describe("which files may be attached", () => {
  it("lets HEIC through, by type or by extension, up to the server's size limit", () => {
    expect(
      image.prepareAttachment(file("IMG_1.HEIC", "image/heic", MAX_UPLOAD_BYTES)),
    ).toHaveProperty("file");
    expect(image.prepareAttachment(file("IMG_1.heif", "", 10))).toHaveProperty("file");
  });
  it("refuses an oversized HEIC with its size, before decoding it", () => {
    expect(image.prepareAttachment(file("IMG_1.heic", "image/heic", MAX_UPLOAD_BYTES + 1))).toEqual(
      { error: "IMG_1.heic is 20 MB. Each attachment can be up to 20 MB." },
    );
  });
  it("keeps the server's rules for everything else", () => {
    expect(image.prepareAttachment(file("scan.tiff", "image/tiff"))).toEqual({
      error: expect.stringContaining("scan.tiff can't be attached"),
    });
    expect(image.prepareAttachment(file("big.jpg", "image/jpeg", MAX_UPLOAD_BYTES + 1))).toEqual({
      error: expect.stringContaining("big.jpg is 20 MB"),
    });
    expect(image.prepareAttachment(file("notes.md", "text/markdown"))).toHaveProperty("file");
  });
});

describe("the shrunk size", () => {
  it.each([
    [4000, 3000, 2048, 1536],
    [3000, 4000, 1536, 2048],
    [2048, 2048, 2048, 2048],
    // Never grows, and a sliver keeps a pixel.
    [1000, 500, 1000, 500],
    [20000, 1, 2048, 1],
    [1, 20000, 1, 2048],
  ])("%d by %d becomes %d by %d", (width, height, shrunkWidth, shrunkHeight) =>
    expect(image.fitWithin(width, height)).toEqual({ width: shrunkWidth, height: shrunkHeight }),
  );
});

describe("optimizeImage", () => {
  type Call = { width: number; height: number; type: string; quality: number | undefined };
  let encoded: Call[];
  let encodes: Record<string, number | null>;
  let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> };
  let decode: ReturnType<typeof vi.fn>;
  let fills: string[];
  // The browser's encoder failing on a real picture, though it passes the 1 by 1 probe for WebP.
  let encodeFails: boolean;
  beforeEach(() => {
    encodeFails = false;
    encoded = [];
    fills = [];
    // A size per type this browser can encode; any other type comes back as a PNG, as Safari answers WebP.
    encodes = { "image/webp": 300_000, "image/jpeg": 400_000 };
    bitmap = { width: 4000, height: 3000, close: vi.fn() };
    decode = vi.fn(async () => bitmap);
    vi.stubGlobal("createImageBitmap", decode);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      // oxlint-disable-next-line typescript/no-this-alias -- the test reads the canvas the code under test made
      const canvas = this;
      return {
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        set fillStyle(color: string) {
          fills.push(color);
        },
        imageSmoothingQuality: "low",
        canvas,
      } as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      callback,
      type,
      quality,
    ) {
      encoded.push({
        width: this.width,
        height: this.height,
        type: type!,
        quality: quality as number | undefined,
      });
      const size = this.width > 1 && encodeFails ? null : encodes[type!];
      callback(
        size === null
          ? null
          : size === undefined
            ? new Blob(["png"], { type: "image/png" })
            : new Blob([new Uint8Array(size)], { type: type! }),
      );
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const photo = (name = "IMG_0042.jpg", type = "image/jpeg", size = 6_000_000) =>
    file(name, type, size);
  // The probe that asks whether WebP encodes is a 1 by 1 canvas; the photo's own encode is the last call.
  const photoEncode = () => encoded.at(-1)!;

  it("decodes with the EXIF rotation applied, caps the long edge, and encodes WebP at the quality the spec names", async () => {
    const result = await image.optimizeImage(photo());
    expect(decode).toHaveBeenCalledWith(expect.any(File), { imageOrientation: "from-image" });
    expect(photoEncode()).toEqual({
      width: MAX_IMAGE_EDGE,
      height: 1536,
      type: "image/webp",
      quality: IMAGE_QUALITY,
    });
    expect(result).toEqual({ file: expect.any(File), size: { width: 2048, height: 1536 } });
    const { file: out } = result as { file: File };
    expect([out.name, out.type, out.size]).toEqual(["IMG_0042.webp", "image/webp", 300_000]);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("sizes a rotated photo by its upright shape", async () => {
    bitmap.width = 3000;
    bitmap.height = 4000;
    expect(await image.optimizeImage(photo())).toMatchObject({
      size: { width: 1536, height: 2048 },
    });
  });

  it("falls back to JPEG, on white, where the browser cannot encode WebP", async () => {
    encodes = { "image/jpeg": 400_000 };
    const result = await image.optimizeImage(photo("Pasted image 09.05.07.webp", "image/webp"));
    expect(photoEncode()).toMatchObject({ type: "image/jpeg", quality: IMAGE_QUALITY });
    expect(fills).toEqual(["#fff"]);
    expect(result).toMatchObject({
      file: { name: "Pasted image 09.05.07.jpg", type: "image/jpeg" },
    });
  });

  it("converts a HEIC photo even when the result is larger, and names it for its new format", async () => {
    encodes["image/webp"] = 5_000_000;
    const result = await image.optimizeImage(file("IMG_0001.HEIC", "image/heic", 1_500_000));
    expect(result).toMatchObject({
      file: { name: "IMG_0001.webp", type: "image/webp", size: 5_000_000 },
    });
  });

  it("names a file with no extension", async () => {
    expect(await image.optimizeImage(file("photo", "image/heic"))).toMatchObject({
      file: { name: "photo.webp" },
    });
    expect(await image.optimizeImage(file(".jpg", "image/jpeg", 2_000_000))).toMatchObject({
      file: { name: "Photo.webp" },
    });
  });

  it("sends the original, with its upright size, when shrinking would not make it smaller", async () => {
    const original = photo("flat.jpg", "image/jpeg", 300_000 + KEEP_UNDER_BYTES);
    encodes["image/webp"] = original.size;
    expect(await image.optimizeImage(original)).toEqual({
      file: original,
      size: { width: 4000, height: 3000 },
    });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["a JPEG under 1 MB", file("a.jpg", "image/jpeg", KEEP_UNDER_BYTES - 1)],
    ["a GIF", file("a.gif", "image/gif", 9_000_000)],
    ["a PNG screenshot", file("Pasted image 09.05.07.png", "image/png", 9_000_000)],
    ["a PDF", file("a.pdf", "application/pdf", 9_000_000)],
  ])("never decodes %s", async (_name, original) => {
    expect(await image.optimizeImage(original)).toEqual({ file: original });
    expect(decode).not.toHaveBeenCalled();
  });

  describe("when the browser cannot decode the photo", () => {
    beforeEach(() => {
      decode.mockRejectedValue(
        new DOMException("The source image could not be decoded.", "InvalidStateError"),
      );
    });
    it("sends a JPEG as it is, since the server takes it", async () => {
      const original = photo();
      expect(await image.optimizeImage(original)).toEqual({ file: original });
    });
    it("sends a WebP as it is", async () => {
      const original = photo("a.webp", "image/webp");
      expect(await image.optimizeImage(original)).toEqual({ file: original });
    });
    it("refuses a HEIC photo, since the server cannot take it, and says which file and why", async () => {
      expect(await image.optimizeImage(file("IMG_0001.heic", "image/heic"))).toEqual({
        error:
          "IMG_0001.heic is a HEIC photo, and this browser can't open it. Convert it to JPEG, or try Safari.",
      });
    });
  });

  describe("when encoding fails", () => {
    it("sends a JPEG as it is, and releases the decoded picture", async () => {
      encodeFails = true;
      const original = photo();
      expect(await image.optimizeImage(original)).toEqual({ file: original });
      expect(bitmap.close).toHaveBeenCalledOnce();
    });
    it("refuses a HEIC photo", async () => {
      encodeFails = true;
      expect(await image.optimizeImage(file("IMG_0001.heic", "image/heic"))).toEqual({
        error: expect.stringContaining("HEIC photo"),
      });
      expect(bitmap.close).toHaveBeenCalledOnce();
    });
    it("sends a JPEG as it is when the canvas gives no drawing context", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      const original = photo();
      expect(await image.optimizeImage(original)).toEqual({ file: original });
    });
  });
});
