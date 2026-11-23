import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Conflict } from "../../shared/errors.js";
import type { FileRef } from "../../shared/types.js";
import { MAX_UPLOAD_BYTES } from "../../shared/uploads.js";
import type { FileSigner } from "../hermes-files.js";

export interface ImageGenerationOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Host-owned storage. Keep it outside any bot's writable workspace. */
  outputDir: string;
  files: FileSigner;
  /** Additional trusted origins for image URLs returned by the API. */
  downloadOrigins?: readonly string[];
}

const maxJsonBytes = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 64 * 1024;
const providerError = () => new Conflict("The image provider did not return a usable image.");

function endpoint(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Invalid image provider URL.");
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${basePath.endsWith("/v1") ? "" : "/v1"}/images/generations`;
  return url;
}

async function readResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw providerError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw providerError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function imageFormat(data: Buffer): "png" | "webp" {
  if (data.length > 16 && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "png";
  if (
    data.length > 16 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP" &&
    data.readUInt32LE(4) === data.length - 8
  )
    return "webp";
  throw providerError();
}

export async function generateImageTool({
  prompt,
  size,
  quality,
  apiKey,
  baseUrl = "https://api.openai.com",
  model = "gpt-image-2.5-flare",
  outputDir,
  botId,
  files,
  downloadOrigins = [],
  signal,
}: ImageGenerationOptions & {
  prompt: string;
  size?: string;
  quality?: string;
  botId: string;
  signal?: AbortSignal;
}): Promise<FileRef> {
  const url = endpoint(baseUrl);
  const timeout = AbortSignal.timeout(120_000);
  const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let image: Buffer;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, size, quality, n: 1 }),
      signal: fetchSignal,
      redirect: "error",
    });
    const { data } = JSON.parse((await readResponse(response, maxJsonBytes)).toString("utf8")) as {
      data?: { b64_json?: unknown; url?: unknown }[];
    };
    const item = Array.isArray(data) ? data[0] : undefined;
    if (typeof item?.b64_json === "string") {
      image = Buffer.from(item.b64_json, "base64");
      if (image.length > MAX_UPLOAD_BYTES || image.toString("base64") !== item.b64_json)
        throw providerError();
    } else if (typeof item?.url === "string") {
      const download = new URL(item.url);
      if (
        download.username ||
        download.password ||
        (download.origin !== url.origin &&
          (download.protocol !== "https:" || !downloadOrigins.includes(download.origin)))
      )
        throw providerError();
      image = await readResponse(
        await fetch(download, { signal: fetchSignal, redirect: "error" }),
        MAX_UPLOAD_BYTES,
      );
    } else throw providerError();
  } catch {
    signal?.throwIfAborted();
    throw providerError();
  }
  const extension = imageFormat(image);
  const destination = resolve(outputDir);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (!(await lstat(destination)).isDirectory()) throw new Error("Invalid image output directory.");
  const directory = await realpath(destination);

  signal?.throwIfAborted();
  const name = `${randomUUID()}.${extension}`;
  const path = join(directory, name);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(image);
    await file.close();
    signal?.throwIfAborted();
    return {
      ...files.signFile({
        path,
        name,
        mime: `image/${extension}`,
        botId,
        kind: "artifact",
        version: 1,
      }),
      size: image.length,
    };
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
}
