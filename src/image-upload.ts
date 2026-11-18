import { prepareUpload, tooLarge, MAX_UPLOAD_BYTES } from "./shared/uploads";
import type { ImageSize } from "./app/image-sizes";

// Phone photos are 3 to 12 MB and 4000 px wide, and the transcript shows them at most a few hundred px wide. The
// composer shrinks them before they upload, which is most of the upload time and all of the later load time.
// The iOS app takes another route (it uploads JPEG, PNG and WebP as they are, converts HEIC to PNG up to 4096 px, and
// encodes camera shots at 0.9), so this does not mirror it beyond keeping GIFs whole and converting HEIC.
/** The longest side of a shrunk photo. Larger than any transcript card, and enough to read a photographed page. */
export const MAX_IMAGE_EDGE = 2048;
export const IMAGE_QUALITY = 0.85;
/** A JPEG or WebP under this uploads as it is: re-encoding it saves little and costs a decode. */
export const KEEP_UNDER_BYTES = 1024 * 1024;
const HEIC_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
/** Added to the file picker beside UPLOAD_ACCEPT. The server never receives HEIC; the composer converts it first. */
export const HEIC_ACCEPT = [...HEIC_TYPES.slice(0, 2), ".heic", ".heif"].join(",");

export type ImageKind = "jpeg" | "webp" | "png" | "gif" | "heic";

/** The image format a file claims, by type, or by extension when the system names no type, as Windows does for HEIC. */
export function imageKind(file: Pick<File, "type" | "name">): ImageKind | undefined {
  const mime = file.type.split(";", 1)[0]!.trim().toLowerCase();
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/png") return "png";
  if (mime === "image/gif") return "gif";
  if (HEIC_TYPES.includes(mime)) return "heic";
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  return (!mime || mime === "application/octet-stream") &&
    (extension === "heic" || extension === "heif")
    ? "heic"
    : undefined;
}

/**
 * Whether an image is shrunk before upload.
 * - GIF: never, so an animation survives.
 * - PNG: never. Screenshots are mostly flat color and text, which PNG stores smaller than JPEG or WebP can and keeps
 *   sharp, and a PNG may carry transparency. A photo saved as PNG still uploads whole, up to the server's limit.
 * - HEIC: always, because the server cannot take it.
 * - JPEG and WebP: from 1 MB up, the point where the upload starts to be felt.
 */
export function needsPreparation(file: Pick<File, "type" | "name" | "size">) {
  const kind = imageKind(file);
  return kind === "heic" || ((kind === "jpeg" || kind === "webp") && file.size >= KEEP_UNDER_BYTES);
}

/** Like `prepareUpload`, and also lets a HEIC photo through for `optimizeImage` to convert. */
export function prepareAttachment(file: File): { file: File } | { error: string } {
  if (imageKind(file) !== "heic") return prepareUpload(file);
  return file.size > MAX_UPLOAD_BYTES ? { error: tooLarge(file) } : { file };
}

/** The size an image of this shape takes under the long-edge cap; it never grows. */
export function fitWithin(width: number, height: number, edge = MAX_IMAGE_EDGE): ImageSize {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const baseName = (name: string) => name.replace(/\.[^./\\]*$/, "") || "Photo";

let webpEncodes: Promise<boolean> | undefined;
/** Safari answers a WebP request with a PNG, so the output type is whatever the browser actually produced. */
const canEncodeWebp = () =>
  (webpEncodes ??= new Promise<boolean>((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    canvas.toBlob((blob) => resolve(blob?.type === "image/webp"), "image/webp");
  }).catch(() => false));

const toBlob = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, IMAGE_QUALITY));

export type OptimizedImage =
  | {
      file: File;
      /** The image's size as the person sees it, with its EXIF rotation applied. Absent when the browser never decoded it. */
      size?: ImageSize;
    }
  | { error: string };

/**
 * Shrinks a photo for upload: decodes it with its EXIF rotation applied, caps the long edge, and encodes WebP where
 * the browser can, else JPEG. A file that needs no shrinking, or whose result would not be smaller, is returned as it
 * is. A JPEG or WebP the browser cannot decode is sent as it is, since the server takes it; a HEIC photo it cannot
 * decode is refused with the reason, since the server would refuse it.
 */
export async function optimizeImage(file: File): Promise<OptimizedImage> {
  if (!needsPreparation(file)) return { file };
  const heic = imageKind(file) === "heic";
  const failed = (): OptimizedImage =>
    heic
      ? {
          error: `${file.name || "This photo"} is a HEIC photo, and this browser can't open it. Convert it to JPEG, or try Safari.`,
        }
      : { file };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return failed();
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height);
    const type = (await canEncodeWebp()) ? "image/webp" : "image/jpeg";
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return failed();
    // JPEG has no transparency; a transparent pixel would turn black.
    if (type === "image/jpeg") {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, size.width, size.height);
    }
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await toBlob(canvas, type);
    if (!blob || blob.type !== type) return failed();
    if (!heic && blob.size >= file.size)
      return { file, size: { width: bitmap.width, height: bitmap.height } };
    const name = `${baseName(file.name)}.${type === "image/webp" ? "webp" : "jpg"}`;
    return { file: new File([blob], name, { type, lastModified: file.lastModified }), size };
  } catch {
    return failed();
  } finally {
    bitmap.close();
  }
}
