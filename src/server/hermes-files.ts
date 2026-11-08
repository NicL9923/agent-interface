import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FileRef } from '../shared/types.js';
import { unavailable, type Wire } from './hermes-transport.js';

/** A Hermes file this server vouched for. Its signed form is the only way a client names it. */
export type RegisteredFile = {path: string; name: string; mime: string; botId: string; kind: 'upload' | 'artifact'; version: 1};

const mimeByExtension: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
};

/** An absolute Hermes path with no NUL byte and no parent segment. */
export function safeStagedPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..');
}

/** Signs and verifies file identifiers with the Hermes token, so only this server can mint them. */
export function fileSigner(token: string | undefined) {
  function signFile(value: RegisteredFile): FileRef {
    if (!token) throw unavailable();
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature = createHmac('sha256', token).update(body).digest('base64url');
    const id = `${body}.${signature}`;
    return {id, name: value.name, mime: value.mime, url: `/api/files/${encodeURIComponent(id)}`};
  }
  function fileValue(id: string): RegisteredFile {
    if (!token) throw unavailable();
    const [body, signature, ...extra] = id.split('.');
    if (!body || !signature || extra.length) throw new Error('Invalid file identifier.');
    const expected = createHmac('sha256', token).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid file identifier.');
    const value = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (value.version !== 1 || !['upload', 'artifact'].includes(value.kind) || !safeStagedPath(value.path) ||
        typeof value.botId !== 'string' || typeof value.name !== 'string' || typeof value.mime !== 'string')
      throw new Error('Unregistered file identifier.');
    return value;
  }
  function artifacts(botId: string, row: Wire): FileRef[] {
    // Only the revision-bound executor can attest output provenance and path policy.
    // Never turn message text or a tool's unverified JSON path into a download capability.
    const descriptors = row.role === 'user' ? row.app_attachments : row.app_artifacts;
    if (!Array.isArray(descriptors)) return [];
    const seen = new Set<string>();
    return descriptors.flatMap((file: Wire) => {
      if (!safeStagedPath(file.path) || seen.has(file.path)) return [];
      seen.add(file.path);
      const name = typeof file.name === 'string' ? file.name : file.path.split('/').pop() ?? 'file';
      const extension = name.split('.').pop()?.toLowerCase();
      const mime = typeof file.mime === 'string' ? file.mime : mimeByExtension[extension ?? ''] ?? 'application/octet-stream';
      return [signFile({path: file.path, name, mime, botId, kind: row.role === 'user' ? 'upload' : 'artifact', version: 1})];
    });
  }
  return {signFile, fileValue, artifacts};
}
