import { fileKeys, fileSigner } from "../../src/server/file-signer.js";

/** One fixed file key, so every runtime a test opens verifies the identifiers another signed. */
export const testFileKey = { id: "test", secret: "test-file-signing-secret" };
export const testFiles = (legacyToken?: string) => fileSigner(fileKeys(testFileKey), legacyToken);
