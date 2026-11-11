/**
 * The app, and a second port where the server reports the CSP violations the browser sent it. `E2E_PORT` moves both,
 * so a measuring tool can run beside another worktree's suite. `.agents/tools/check-all` picks a free pair and sets it;
 * run without that tool, the suite uses 4173 and 4174.
 */
const raw = process.env.E2E_PORT;
export const port = raw ? Number(raw) : 4173;
// A typo must not quietly fall back to 4173, where another worktree's suite may be listening.
if (!Number.isInteger(port) || port < 1024 || port > 65534) {
  throw new Error(`E2E_PORT must be a whole number from 1024 to 65534 (the control port is the next one), got ${JSON.stringify(raw)}.`);
}
export const controlPort = port + 1;
