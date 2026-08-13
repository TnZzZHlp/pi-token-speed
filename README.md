# pi-token-speed

`pi-token-speed` is a [Pi](https://github.com/earendil-works/pi-mono) extension that shows the model's live token output speed in the footer while a response streams.

During generation the footer displays the current output speed measured over a rolling three-second window, for example `12.4 tok/s`. When the response finishes it switches to the message average with exact token usage, for example `avg 15 tok/s | 1,024 tok | 67.3s`, and clears after a few seconds.

Run `/speed` any time to see the last finished message alongside session totals:

```text
Session: 5 replies | 3,812 tok output | avg 14.6 tok/s
Last: avg 15.2 tok/s | 1,024 tok | 67.3s
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

- `message_update` deltas (text, thinking, and tool-call fragments) are measured against a rolling time window. Tokens are estimated at 4 characters per token while streaming.
- At `message_end` the estimate is replaced by the provider-reported `usage.output` token count, and the footer shows the response average.
- `thinking` phases are included in the count and labeled `(thinking)` in the footer.
- The footer is throttled to about seven updates per second so streaming is not slowed by status rendering.

## Privacy

The extension only observes events and session data Pi already exposes to extensions. It makes no network requests and persists nothing.

## Development

```bash
npm test
```

The package has no runtime npm dependencies.