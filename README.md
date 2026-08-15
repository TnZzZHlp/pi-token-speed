# pi-token-speed

`pi-token-speed` is a [Pi](https://github.com/earendil-works/pi-mono) extension that keeps the model's average token output speed and duration in the footer. In every state only these two values are shown.

While a response streams, the footer shows the running average speed and elapsed time of the current message, for example `17.3 tok/s | 12.4s`. When the response finishes, the exact token count from the provider replaces the estimate and the final values stay in the footer until the next response starts.

Instead of occupying the separate extension status line at the bottom, the speed is merged into the same stats line as the other footer information (token usage, cache, context usage, model name), separated by a bullet:

```text
~/project (main)                 ↑1.2k ↓3.8k R45k CH92.3% $0.050 12.3%/200k • 17.3 tok/s | 12.4s                my-model
```

To do this the extension installs a custom footer with `ctx.ui.setFooter()` that mirrors pi's built-in footer layout. Indicators pi does not expose to extensions (`(auto)` after the context usage, `(sub)` cost labels, and the `xp` marker) are omitted. Status texts from other extensions are merged onto the same line after the speed. When the custom footer is unavailable (for example RPC mode), the speed falls back to the regular extension status line.

Run `/speed` any time to see the last finished message alongside session totals:

```text
Session: 5 replies | 3,812 tok output | avg 14.6 tok/s
Last: 15.2 tok/s | 67.3s
```

## Install

Install from GitHub:

```bash
pi install git:github.com/TnZzZHlp/pi-token-speed
```

Pi also accepts the repository URL directly:

```bash
pi install https://github.com/TnZzZHlp/pi-token-speed
```

To try a local checkout for one Pi run without installing it:

```bash
pi -e /absolute/path/to/pi-token-speed/extensions/token-speed.js
```

Restart Pi, or run `/reload` in an existing interactive session, after installation.

## How it works

- `message_update` deltas (text, thinking, and tool-call fragments) are counted as they arrive. Tokens are estimated at 4 characters per token while streaming, and the footer shows the running average speed and elapsed time of the current message.
- At `message_end` the estimate is replaced by the provider-reported `usage.output` token count, and the duration becomes the total response time. The final values stay in the footer until the next response starts.
- `thinking` phases are included in the count and labeled `(thinking)` in the footer.
- A custom footer (`ctx.ui.setFooter()`) mirrors pi's built-in footer and appends the speed to the stats line, so the speed shares a line with the other footer information instead of taking its own status row. `ctx.ui.setStatus()` is still called for modes without a custom footer (for example RPC).
- The footer is throttled to about seven updates per second so streaming is not slowed by status rendering.

## Notes

- The custom footer mirrors the built-in footer of the pi version it was written against; upgrading pi may require updating the mirrored layout in `extensions/token-speed.js`.
- Indicators pi does not expose to extensions (`(auto)`, `(sub)`, `xp`) are omitted from the custom footer.

## Privacy

The extension only observes events and session data Pi already exposes to extensions. It makes no network requests and persists nothing.

## Development

```bash
npm test
```

The package has no runtime npm dependencies.