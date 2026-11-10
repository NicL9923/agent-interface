/**
 * The app, and a second port where the server reports the CSP violations the browser sent it. `E2E_PORT` moves both,
 * so a measuring tool can run beside another worktree's suite.
 */
export const port = Number(process.env.E2E_PORT) || 4173;
export const controlPort = port + 1;
