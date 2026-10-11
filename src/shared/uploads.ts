// One definition of what a message attachment may be, shared by the composer and the upload route.
export const UPLOAD_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"] as const;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const UPLOAD_KINDS = "PNG, JPEG, WebP or GIF images, PDFs, or plain text";
// The picker also offers common text formats, which the composer sends as plain text.
const TEXT_EXTENSIONS = ["txt", "md", "markdown", "csv", "log"];
export const UPLOAD_ACCEPT = [...UPLOAD_MIME_TYPES, "text/markdown", "text/csv", ...TEXT_EXTENSIONS.map(extension => `.${extension}`)].join(",");

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// Returns the file to upload, normalized to an accepted type, or why it cannot be attached.
export function prepareUpload(file: File): { file: File } | { error: string } {
  const name = file.name || "Untitled file";
  const mime = file.type.split(";", 1)[0]!.trim().toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  let prepared = file;
  if (!(UPLOAD_MIME_TYPES as readonly string[]).includes(mime)) {
    if (mime.startsWith("text/") || (!mime && TEXT_EXTENSIONS.includes(extension)))
      prepared = new File([file], name, { type: "text/plain", lastModified: file.lastModified });
    else return { error: `${name} can't be attached. Use ${UPLOAD_KINDS}.` };
  }
  if (file.size > MAX_UPLOAD_BYTES)
    return { error: `${name} is ${formatBytes(file.size)}. Each attachment can be up to ${formatBytes(MAX_UPLOAD_BYTES)}.` };
  return { file: prepared };
}

// Browsers name every pasted screenshot "image.png"; give each a name worth reading in the chat.
export function namePastedFile(file: File, at: Date, index: number) {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const extension = /^image\/(png|jpeg|gif|webp)$/.exec(file.type)?.[1]?.replace("jpeg", "jpg") ?? "png";
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map(part => String(part).padStart(2, "0")).join(".");
  return new File([file], `Pasted image ${time}${index ? ` (${index + 1})` : ""}.${extension}`, { type: file.type, lastModified: file.lastModified });
}

// Pasting copied spreadsheet cells also carries a rendered picture; keep that a text paste.
// A copied file in Finder or Explorer carries only its own name as text, so attach it.
export function pastedFiles(data: Pick<DataTransfer, "files" | "getData">): File[] {
  const files = Array.from(data.files);
  if (!files.length) return [];
  const text = data.getData("text/plain").trim();
  if (!text) return files;
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.every(line => files.some(file => file.name && line.endsWith(file.name))) ? files : [];
}
