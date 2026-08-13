/**
 * Token speed status extension.
 *
 * While an assistant message streams, the footer shows the current output
 * speed. Deltas arriving through `message_update` (text, thinking, and tool
 * call fragments) are measured against a rolling time window. Because tokens
 * are estimated from characters (CHARS_PER_TOKEN), a final exact token count is
 * taken from `usage.output` when the message ends.
 */

export const STATUS_KEY = "token-speed";
export const CHARS_PER_TOKEN = 4;
export const SPEED_WINDOW_MS = 3_000;
export const UI_UPDATE_INTERVAL_MS = 150;
export const STATUS_HOLD_MS = 6_000;

function asFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Estimate the number of tokens a character count roughly corresponds to.
 *
 * @param {number} chars
 */
export function estimateTokens(chars) {
	return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN));
}

/**
 * Return the token-counting contribution of one streaming event.
 *
 * @param {object | undefined} event
 */
export function deltaContribution(event) {
	if (
		!event ||
		(event.type !== "text_delta" &&
			event.type !== "thinking_delta" &&
			event.type !== "toolcall_delta") ||
		typeof event.delta !== "string"
	) {
		return { chars: 0, tokens: 0 };
	}

	const chars = event.delta.length;
	return { chars, tokens: estimateTokens(chars) };
}

/**
 * Measure output speed (tokens per second) over a rolling window of samples.
 * The window is anchored at the earliest sample inside it, so a stalled stream
 * keeps its last measured rate instead of decaying toward zero.
 *
 * @param {Array<{at: number, tokens: number}>} samples
 * @param {number} now - current timestamp in milliseconds
 * @param {number} [windowMs]
 */
export function measureSpeed(samples, now, windowMs = SPEED_WINDOW_MS) {
	if (!Array.isArray(samples) || samples.length === 0) return 0;

	const cutoff = now - windowMs;
	let first = samples.length;
	for (let i = 0; i < samples.length; i++) {
		if (samples[i].at >= cutoff) {
			first = i;
			break;
		}
	}
	if (first === samples.length) return 0;

	let tokens = 0;
	let lastAt = samples[first].at;
	for (let i = first; i < samples.length; i++) {
		tokens += samples[i].tokens;
		if (samples[i].at > lastAt) lastAt = samples[i].at;
	}

	const elapsedSec = (lastAt - samples[first].at) / 1000;
	if (elapsedSec <= 0) return 0;
	return tokens / elapsedSec;
}

/**
 * Format a tokens-per-second value for footer display.
 *
 * @param {number} tokensPerSecond
 */
export function formatSpeed(tokensPerSecond) {
	const value = asFiniteNumber(tokensPerSecond);
	if (value === undefined || value < 0.05) return "<0.1";
	if (value < 10) return value.toFixed(1);
	return Math.round(value).toString();
}

/**
 * Format the live footer status while a message is streaming.
 *
 * @param {{tokensPerSecond: number, thinking: boolean}} info
 */
export function formatLiveStatus(info) {
	const speed = asFiniteNumber(info?.tokensPerSecond);
	if (speed === undefined) return undefined;
	return `${formatSpeed(speed)} tok/s${info.thinking ? " (thinking)" : ""}`;
}

/**
 * Format the footer status shown after a message finishes.
 *
 * @param {{tokens: number, durationMs: number}} stats
 */
export function formatFinalStatus(stats) {
	const tokens = asFiniteNumber(stats?.tokens);
	if (tokens === undefined) return undefined;
	const durationSec = asFiniteNumber(stats?.durationMs)
		? Math.max(0, stats.durationMs / 1000)
		: 0;
	const average = durationSec > 0 ? tokens / durationSec : 0;
	return `avg ${formatSpeed(average)} tok/s | ${tokens.toLocaleString("en-US")} tok | ${durationSec.toFixed(1)}s`;
}

/**
 * Format the current session summary for the /speed command.
 *
 * @param {Array<{tokens: number, durationMs: number}> | undefined} messages
 */
export function formatSpeedSummary(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return undefined;

	let tokens = 0;
	let durationMs = 0;
	let measured = 0;
	for (const message of messages) {
		const messageTokens = asFiniteNumber(message?.tokens) ?? 0;
		const messageDuration = asFiniteNumber(message?.durationMs) ?? 0;
		tokens += messageTokens;
		durationMs += messageDuration;
		if (messageTokens > 0 && messageDuration > 0) measured++;
	}

	const durationSec = durationMs / 1000;
	const average = durationSec > 0 ? tokens / durationSec : 0;
	const body = `${messages.length} ${messages.length === 1 ? "reply" : "replies"} | ${tokens.toLocaleString("en-US")} tok output | avg ${formatSpeed(average)} tok/s`;
	return {
		text: `Session: ${body}`,
		detail: { messages: messages.length, tokens, durationMs: Math.round(durationMs), measured },
	};
}

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function tokenSpeedExtension(pi) {
	let activeStream;
	let messageStats = [];
	let lastUiUpdateAt = 0;
	let holdTimer;
	let lastFinalText;

	function setStatus(ctx, text) {
		try {
			if (ctx.hasUI === false) return;
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// Footer updates must never break streaming.
		}
	}

	function clearHoldTimer() {
		if (holdTimer) clearTimeout(holdTimer);
		holdTimer = undefined;
	}

	function scheduleClear(ctx) {
		clearHoldTimer();
		holdTimer = setTimeout(() => {
			holdTimer = undefined;
			if (!activeStream) setStatus(ctx, undefined);
		}, STATUS_HOLD_MS);
		holdTimer.unref?.();
	}

	function maybeUpdateLiveStatus(ctx, now) {
		if (!activeStream) return;
		if (now - lastUiUpdateAt < UI_UPDATE_INTERVAL_MS) return;

		lastUiUpdateAt = now;

		const tokensPerSecond = measureSpeed(
			activeStream.samples,
			now,
			activeStream.windowMs ?? SPEED_WINDOW_MS,
		);
		setStatus(ctx, formatLiveStatus({ tokensPerSecond, thinking: activeStream.thinking }));
	}

	pi.on("message_start", (_event, _ctx) => {
		if (_event.message.role !== "assistant") return;
		clearHoldTimer();
		activeStream = {
			startAt: 0,
			lastDeltaAt: 0,
			chars: 0,
			estimatedTokens: 0,
			thinking: false,
			samples: [],
		};
		lastUiUpdateAt = Date.now();
	});

	pi.on("message_update", (event, ctx) => {
		if (!activeStream) return;

		const contribution = deltaContribution(event.assistantMessageEvent);
		if (contribution.chars === 0) return;
		if (ctx.hasUI === false) return;

		const now = Date.now();
		activeStream.startAt = activeStream.startAt || now;
		activeStream.lastDeltaAt = now;
		activeStream.chars += contribution.chars;
		activeStream.estimatedTokens += contribution.tokens;
		if (event.assistantMessageEvent.type === "thinking_delta") {
			activeStream.thinking = true;
		}
		activeStream.samples.push({ at: now, tokens: contribution.tokens });

		maybeUpdateLiveStatus(ctx, now);
	});

	pi.on("message_end", (event, ctx) => {
		if (!activeStream || event.message.role !== "assistant") return;

		const stream = activeStream;
		activeStream = undefined;
		lastUiUpdateAt = 0;

		if (ctx.hasUI === false || stream.lastDeltaAt === 0) return;

		const usageTokens = asFiniteNumber(event.message.usage?.output);
		const tokens =
			usageTokens !== undefined ? Math.max(usageTokens, 0) : stream.estimatedTokens;
		const durationMs = Math.max(0, stream.lastDeltaAt - stream.startAt);

		if (tokens === 0 || durationMs === 0) return;

		const stats = {
			tokens: Math.round(tokens),
			durationMs: Math.round(durationMs),
			chars: stream.chars,
			estimatedTokens: stream.estimatedTokens,
		};
		messageStats.push(stats);

		lastFinalText = formatFinalStatus(stats);
		setStatus(ctx, lastFinalText);
		scheduleClear(ctx);
	});

	pi.registerCommand("speed", {
		description: "Show live token output speed for the last message and session totals",
		handler: async (_args, ctx) => {
			const summary = formatSpeedSummary(messageStats);
			if (!summary) {
				setStatus(ctx, undefined);
				if (ctx.hasUI !== false) {
					ctx.ui.notify("No assistant output has been measured in this session yet.", "info");
				}
				return;
			}

			const parts = [summary.text];
			if (lastFinalText) parts.push(`Last: ${lastFinalText}`);
			if (ctx.hasUI !== false) {
				ctx.ui.notify(parts.join("\n"), "info");
			}
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearHoldTimer();
		activeStream = undefined;
		messageStats = [];
		lastFinalText = undefined;
		setStatus(ctx, undefined);
	});
}