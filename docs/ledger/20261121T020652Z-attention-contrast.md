# November 21 attention color contrast

Code state: the commit that adds this entry, on top of `af8d1c38` on `t3/fix-attention-contrast`. Node
v24.22.2. Hermes did not take part; the browser checks use the e2e server and its fixtures.

Issue #459: "Needs your help" on an assistant row, in the light theme's `--attention` `#9b6733`, met the
row's fills at 3.84:1 to 4.11:1. The light token is now `#895b2d`, the same 30° hue, darker. The dark
token `#ebc188` passes every use and is unchanged. The routine card's hover goes back to `--rail` at
55%, its strength before #463, since its status word now keeps 5.35:1 on it. The avatar stylesheet's
fallbacks for `--attention`, `#b5813a`, now match the token, like its other fallbacks.

`#8c5d2e` was the first candidate. It reached exactly 4.51:1 on the selected row and on the composer's
attention notice, both on the soft accent, so it had no room. `#895b2d` keeps 4.66:1 there. The sweep
covered `#9b6733`, `#94612f`, `#8f5f2f`, `#8c5d2e`, `#895b2d`, `#87592c` and `#85582b`, set inline on
`:root` in the built app.

## Checks

| Check                                                                             | Result                                                                                        | Evidence                                                 |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| New test, assistant row at rest, hovered and selected, old token, Chromium        | Failed as intended in light: 4.11:1 at rest, 3.96:1 hovered, 3.84:1 selected. Dark passed     | `.private/attention-contrast/red-old-token.log`          |
| Hover tests with the old token and the restored 55% routine hover, Chromium       | Failed as intended in light: warning routine card 4.39:1; assistant row as above. Dark passed | `.private/attention-contrast/red-old-token-55-hover.log` |
| `e2e/accessibility.spec.ts`, new token, Chromium                                  | Runtime-exercised: 13 passed                                                                  | `.private/attention-contrast/green-chromium.log`         |
| `e2e/accessibility.spec.ts`, new token, WebKit in the Playwright 1.65.0 container | Runtime-exercised: 13 passed                                                                  | `.private/attention-contrast/green-webkit.log`           |
| Measurement of every use, both themes, 1280 by 800, Chromium                      | Runtime-exercised: every text pair 4.66:1 or better, every mark 4.66:1 or better              | `.private/attention-contrast/light.txt`, `dark.txt`      |

Each red run put the old token back from a saved copy of `src/styles.css`, rebuilt, ran, and restored
the file and rebuilt before the green run.

The new test reads "Needs your help" on the real Ranch Hand row. The open assistant's row shows its
conversation's state, not the roster's, so the test routes the conversation read to report `blocked`
as well as setting the roster. That is why it sits in the describe that blocks the service worker.

## Uses

The sidebar row and the routine card were read from rendered elements. The other rows composite the
token over the fills their stylesheets name, in a probe inside the app, so the real tokens and
`color-mix` apply. The sidebar row was read in all six seasons; the table gives the worst. The tint
wash was read at 24 hues, the worst given. Text needs 4.5:1; a border, dot or icon that carries
meaning needs 3:1.

| Use                                                  | What it is                        | Background                                  | Light `#9b6733` | Light `#895b2d` | Dark `#ebc188` |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------- | --------------- | --------------- | -------------- |
| `styles.css:24`, `:55`, `:76`                        | Token definitions                 |                                             |                 |                 |                |
| `ui.css:51`                                          | Alias `--color-attention`, unused |                                             |                 |                 |                |
| `styles.css:337` assistant row activity              | Text                              | Rail, at rest                               | 4.11            | 5.00            | 10.33          |
|                                                      |                                   | Soft accent at 55%, hovered                 | 3.93            | 4.79            | 8.03           |
|                                                      |                                   | Soft accent, selected                       | 3.83            | 4.66            | 6.33           |
| `styles.css:351` composer `.notice.attention`        | Text                              | Soft accent                                 | 3.83            | 4.66            | 6.33           |
| `styles.css:816` approval card stripe                | Border                            | Raised card                                 | 4.71            | 5.74            | 8.60           |
| `styles.css:981` conversation activity dot           | Dot                               | Surface; tint wash                          | 4.08            | 4.96            | 7.95           |
| `shell.css:296` interruption review border           | Border                            | Raised; surface beside it                   | 4.51            | 5.50            | 8.60           |
| `shell.css:304` decisions dock row border            | Border                            | Raised; surface beside it                   | 4.51            | 5.50            | 8.60           |
| `shell.css:310` decisions dock row icon              | Icon                              | Raised                                      | 4.71            | 5.74            | 8.60           |
| `shell.css:445` assistant details activity           | Text                              | Surface                                     | 4.51            | 5.50            | 9.76           |
| `attachments.css:311` drop refused icon              | Icon                              | Surface at 84% over rail                    | 4.45            | 5.41            | 9.85           |
| `motion.css:238` avatar burst particles              | Decorative, exempt                |                                             |                 |                 |                |
| `experience.css:189` Today reason                    | Text                              | Raised, at rest                             | 4.71            | 5.74            | 8.60           |
|                                                      |                                   | Soft accent 45% in raised, hovered          | 4.30            | 5.23            | 7.52           |
| `device-notifications.css:70` blocked toggle label   | Text                              | Surface                                     | 4.51            | 5.50            | 9.76           |
| `device-notifications.css:75` blocked switch outline | Border                            | Surface                                     | 4.51            | 5.50            | 9.76           |
| `device-notifications.css:81` blocked notice line    | Text                              | Surface                                     | 4.51            | 5.50            | 9.76           |
| `home.css:737` settings blocked toggle label         | Text                              | Surface                                     | 4.51            | 5.50            | 9.76           |
| `automation.css:220`, `:373`, `:537` callout stripes | Border                            | Surface or raised                           | 4.51            | 5.50            | 8.60           |
| `home.css:69` reconnecting dot                       | Dot                               | Rail ring                                   | 4.11            | 5.00            | 10.33          |
| `home.css:617` settings row status dot               | Dot                               | Raised ring                                 | 4.71            | 5.74            | 8.60           |
| `routine-runs.css:20` status word                    | Text                              | Raised, at rest                             | 4.71            | 5.74            | 8.60           |
|                                                      |                                   | Rail at 55% over raised, hovered            | 4.39            | 5.35            | 9.61           |
| `routine-runs.css:20` status dot                     | Dot                               | Raised                                      | 4.71            | 5.74            | 8.60           |
| `artifacts.css:80` notice                            | Text                              | Surface                                     | 4.51            | 5.50            | 9.76           |
| `computer.css:147` notice                            | Text                              | Rail                                        | 4.11            | 5.00            | 10.33          |
| `computer.css:411` confirm error                     | Text                              | Raised                                      | 4.71            | 5.74            | 8.60           |
| `message-markdown.css:316` code string               | Text                              | Raised code block                           | 4.71            | 5.74            | 8.60           |
| `integrations.css:87` status chip, 20% ink mixed in  | Text                              | Rail                                        | 5.11            | 5.98            | 11.13          |
| `transcript.css:307` find match fill                 | Fill under ink text               | Surface, reply bubble, tinted person bubble | 8.10            | 7.73            | 5.33           |
| `transcript.css:311` current find match fill         | Fill under surface text           | Itself                                      | 4.51            | 5.50            | 9.76           |
| `discovery.css:55` search match fill                 | Fill under ink text               | Raised                                      | 9.41            | 9.00            | 6.09           |
| `usage.css:132` warning usage bar                    | Fill                              | Rail track                                  | 4.11            | 5.00            | 10.33          |
| `avatar.css:54` blocked badge                        | Fill under a surface glyph        | Glyph on badge                              | 4.51            | 5.50            | 9.76           |
| `avatar.css:103` blocked ring                        | Ring                              | Soft accent; surface; tint wash             | 3.83            | 4.66            | 6.33           |

The find match rows give the worst of their backgrounds. A darker token lowers ink's contrast on those
fills in light, and every one stays above 7.5:1.

## Not done

- The red runs ran in Chromium only.
- iOS: `Palette.attention` in `ios/AgentInterface/AvatarView.swift:23` is still `#9B6733` in light.
  This host cannot compile Swift, so the change is left for the Mac.
