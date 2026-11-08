// Match the native portrait picker. Hermes stores portraits up to 2 MB.
export const MAX_PORTRAIT_INPUT_BYTES = 15 * 1024 * 1024;
export const MAX_PORTRAIT_BYTES = 2_000_000;
export const PORTRAIT_INPUT_ERROR = "Choose a PNG, JPEG, or WebP portrait no larger than 15 MB.";

export async function preparePortrait(file: File): Promise<File> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > MAX_PORTRAIT_INPUT_BYTES)
    throw new Error(PORTRAIT_INPUT_ERROR);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("This portrait couldn't be read. Choose another image."));
      image.src = url;
    });
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This portrait couldn't be processed. Try again.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // PNG preserves transparent portraits. At 512px even uncompressed RGBA fits below 2 MB.
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob || blob.size > MAX_PORTRAIT_BYTES) throw new Error("This portrait couldn't be compressed. Choose another image.");
    return new File([blob], "portrait.png", { type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}
