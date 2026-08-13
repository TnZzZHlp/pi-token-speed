/**
 * Token speed status extension.
 *
 * While an assistant message streams, the footer shows the running average
 * output speed of the current message together with the elapsed time. Deltas
 * arriving through `message_update` (text, thinking, and tool call fragments)
 * are counted as they arrive. Because tokens are estimated from characters
 * (CHARS_PER_TOKEN) while streaming, the final token count is taken from
 * `usage.output` when the message ends. In every state only the average speed
 * and the duration are shown, and the final values stay in the footer until
 * the next response starts.
 */

export const STATUS_KEY = "token-speed";
export const CHARS_PER_TOKEN = 4;
export const UI_UPDATE_INTERVAL_MS = 150;

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
 * Format the message average speed and duration for the footer. Used both
 * while a message streams (estimated tokens, live elapsed time) and after it
 * finishes (exact usage tokens, total duration).
 *
 * @param {{tokens: number, durationMs: number}} stats
 */
export function formatAvgSpeed(stats) {
	const tokens = asFiniteNumber(stats?.tokens);
	if (tokens === undefined || tokens === 0) return undefined;
	const durationSec = asFiniteNumber(stats?.durationMs)
		? Math.max(0, stats.durationMs / 1000)
		: 0;
	if (durationSec <= 0) return undefined;
	return `${formatSpeed(tokens / durationSec)} tok/s | ${durationSec.toFixed(1)}s`;
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
	let lastFinalText;

	function setStatus(ctx, text) {
		try {
			if (ctx.hasUI === false) return;
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// Footer updates must never break streaming.
		}
	}

	function maybeUpdateLiveStatus(ctx, now) {
		if (!activeStream) return;
		if (now - lastUiUpdateAt < UI_UPDATE_INTERVAL_MS) return;

		lastUiUpdateAt = now;
		const durationMs = now - activeStream.startAt;
		if (durationMs <= 0 || activeStream.estimatedTokens === 0) return;

		const text = formatAvgSpeed({
			tokens: activeStream.estimatedTokens,
			durationMs,
		});
		if (!text) return;
		setStatus(ctx, activeStream.thinking ? `${text} (thinking)` : text);
	}

	pi.on("message_start", (_event, _ctx) => {
		if (_event.message.role !== "assistant") return;
		activeStream = {
			startAt: 0,
			lastDeltaAt: 0,
			chars: 0,
			estimatedTokens: 0,
			thinking: false,
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

		// The final average stays in the footer until the next response starts.
		lastFinalText = formatAvgSpeed(stats);
		setStatus(ctx, lastFinalText);
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
		activeStream = undefined;
		messageStats = [];
		lastFinalText = undefined;
		setStatus(ctx, undefined);
	});
}