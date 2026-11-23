# WildBots MCP and mini-vault verification

The code snapshot has staged diff SHA-256 `62bcc76b288770c8bb44d7964e52d5e13e4eb0004cd39385e79759979885849e` against Wave 2 commit `2ee7ec9a9c2e407deb27ba33efbd21963e09e965`.

| Command                                                     | Result                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm ci`                                                    | Installed the worktree dependencies. npm reported 0 vulnerabilities and warned about the esbuild install script.         |
| `npm run typecheck && npm run lint && npm run format:check` | All three commands exited 0.                                                                                             |
| `npx vitest run tests/wildbots-mcp.test.ts`                 | One file passed, with 14 tests. The tests exercised real SQLite, the loopback MCP server, and a loopback image provider. |
| Bun 1.4.5 loopback initialization smoke                     | The server replied with HTTP 200, MCP protocol `2025-11-25`, and the tools capability.                                   |

Each temporary mutation below failed its selected test with an assertion error. The source files were restored byte for byte before the passing run.

| Temporary mutation                                            | Failure                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Accept a known session locator with an incorrect token secret | The test received HTTP 200 where it expected 401.                                                      |
| Include a second bot in the transcript search scope           | The search returned two hits where the test expected one.                                              |
| Include the bot owner's scope even when the bot is shared     | The shared bot's list exposed the owner's secret name.                                                 |
| Remove the secret name from AES-GCM associated data           | A secret read succeeded after the row's name changed.                                                  |
| Return the card's submitted value in its tool result          | The structured result included the private value where the test expected status and save confirmation. |

## Image output paths

The image path fix has diff SHA-256 `8d1859f05cbdd56193298365565c984661c326641066b7aebcb86e4c7f9eb326` against `e6763bd41722fe2b4158aafbc353614c1b53d237`.

Before the fix, the image test received a tool error for a generated file under a symlinked parent directory. After the fix, the test verified that the signed path uses the real directory and that a symlink at the output directory itself is refused. Typecheck, lint, formatting, and all 14 loopback tests passed again.
