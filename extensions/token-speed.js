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
 *
 * Instead of occupying the separate extension status line, the speed is merged
 * into the built-in stats line (token usage, cache, context usage, model name)
 * via a custom footer installed with `ctx.ui.setFooter()`. The custom footer
 * mirrors pi's built-in footer layout. Indicators that pi does not expose to
 * extensions ((auto), (sub), xp) are omitted, and the speed is appended after
 * the context usage with a bullet separator.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export const STATUS_KEY = "token-speed";
export const CHARS_PER_TOKEN = 4;
export const UI_UPDATE_INTERVAL_MS = 150;

/** Matches ANSI SGR sequences like `\x1b[2m`. */
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

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
 * Return whether a code point occupies two terminal cells (East Asian wide).
 *
 * @param {number} code
 */
function isWideChar(code) {
	return (
		(code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
		(code >= 0x2e80 && code <= 0x303e) || // CJK Radicals .. CJK Symbols
		(code >= 0x3041 && code <= 0x33ff) || // Hiragana .. CJK Compatibility
		(code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
		(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
		(code >= 0xa000 && code <= 0xa4cf) || // Yi Syllables
		(code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
		(code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
		(code >= 0xfe30 && code <= 0xfe4f) || // CJK Compatibility Forms
		(code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
		(code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
		(code >= 0x20000 && code <= 0x3fffd) //  CJK Extension B and beyond
	);
}

/**
 * Visible width of a string. ANSI SGR sequences count as zero cells and wide
 * East Asian characters count as two.
 *
 * @param {string} text
 */
export function visibleWidth(text) {
	const tokens = String(text).match(ANSI_SGR) ? String(text).split(ANSI_SGR) : [String(text)];
	let width = 0;
	for (const token of tokens) {
		for (const char of token) {
			width += isWideChar(char.codePointAt(0)) ? 2 : 1;
		}
	}
	return width;
}

/**
 * Truncate a string (which may contain ANSI SGR sequences) to a visible
 * width, appending a suffix (e.g. "...") when truncation is needed. ANSI
 * sequences are preserved intact.
 *
 * @param {string} text
 * @param {number} width
 * @param {string} [suffix]
 */
export function truncateToWidth(text, width, suffix = "") {
	const textStr = String(text);
	const suffixWidth = visibleWidth(suffix);
	if (visibleWidth(textStr) + suffixWidth <= width) return textStr;

	const target = Math.max(0, width - suffixWidth);
	let out = "";
	let used = 0;
	for (const token of textStr.match(/\x1b\[[0-9;]*m|[^\x1b]/g) ?? []) {
		if (token.startsWith("\x1b")) {
			// Keep ANSI codes even past the break point so open styles are closed.
			out += token;
			continue;
		}
		const tokenWidth = isWideChar(token.codePointAt(0)) ? 2 : 1;
		if (used + tokenWidth > target) continue;
		out += token;
		used += tokenWidth;
	}
	return `${out}${suffix}`;
}

/**
 * Format a token count for compact footer display, mirroring pi's built-in
 * footer.
 *
 * @param {number} count
 */
export function formatTokens(count) {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Shorten a working directory to `~`-relative when it is inside the home
 * directory, mirroring pi's built-in footer.
 *
 * @param {string} cwd
 * @param {string | undefined} home
 */
function formatCwdForFooter(cwd, home) {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Replace control characters that would break a single-line status display,
 * mirroring pi's built-in footer.
 *
 * @param {string} text
 */
function sanitizeStatusText(text) {
	return String(text)
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Build the left-hand stats parts of the footer line. The speed text and any
 * other extensions' status texts are appended after the context usage with a
 * bullet separator, so everything shares one line.
 *
 * @param {{totals: {input: number, output: number, cacheRead: number, cacheWrite: number, cost: number}, cacheHitRate: number | undefined, contextPercentDisplay: string, speedText: string | undefined, statusTexts: string[]}} options
 */
export function buildStatsParts({
	totals,
	cacheHitRate,
	contextPercentDisplay,
	speedText,
	statusTexts = [],
}) {
	const parts = [];
	if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && cacheHitRate !== undefined) {
		parts.push(`CH${cacheHitRate.toFixed(1)}%`);
	}
	if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
	parts.push(contextPercentDisplay);
	if (speedText) parts.push(`• ${speedText}`);
	for (const status of statusTexts) parts.push(`• ${status}`);
	return parts;
}

/**
 * Render the two footer lines that replace pi's built-in footer: the pwd line
 * and the stats line with the token speed merged into it. Mirrors pi's
 * built-in footer layout, minus indicators extensions cannot read.
 *
 * @param {{theme: object, footerData: object, ctx: object, speedText: string | undefined, width: number}} options
 */
export function renderMergedFooter({ theme, footerData, ctx, speedText, width }) {
	const { sessionManager } = ctx;
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let cacheHitRate;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost.total;
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			cacheHitRate =
				promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.usage
		) {
			const usage = entry.message.usage;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost.total;
		} else if (
			(entry.type === "branch_summary" || entry.type === "compaction") &&
			entry.usage
		) {
			const usage = entry.usage;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost.total;
		}
	}

	const contextUsage = ctx.getContextUsage();
	const model = ctx.model;
	const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

	let pwd = formatCwdForFooter(
		sessionManager.getCwd(),
		process.env.HOME || process.env.USERPROFILE,
	);
	const branch = footerData.getGitBranch();
	if (branch) pwd = `${pwd} (${branch})`;
	const sessionName = sessionManager.getSessionName();
	if (sessionName) pwd = `${pwd} • ${sessionName}`;

	let contextPercentDisplay = `${contextPercent}%/${formatTokens(contextWindow)}`;
	if (contextPercentValue > 90) {
		contextPercentDisplay = theme.fg("error", contextPercentDisplay);
	} else if (contextPercentValue > 70) {
		contextPercentDisplay = theme.fg("warning", contextPercentDisplay);
	}

	const statusTexts = [];
	for (const [key, text] of footerData.getExtensionStatuses()) {
		if (key === STATUS_KEY) continue;
		statusTexts.push(sanitizeStatusText(text));
	}

	const statsParts = buildStatsParts({
		totals,
		cacheHitRate,
		contextPercentDisplay,
		speedText,
		statusTexts,
	});
	let statsLeft = statsParts.join(" ");
	let statsLeftWidth = visibleWidth(statsLeft);
	if (statsLeftWidth > width) {
		statsLeft = truncateToWidth(statsLeft, width, "...");
		statsLeftWidth = visibleWidth(statsLeft);
	}

	const modelName = model?.id || "no-model";
	const minPadding = 2;
	let rightSide = modelName;
	if (model?.reasoning) {
		const thinkingLevel = ctx.thinkingLevel || "off";
		rightSide =
			thinkingLevel === "off"
				? `${modelName} • thinking off`
				: `${modelName} • ${thinkingLevel}`;
	}
	if (footerData.getAvailableProviderCount() > 1 && model) {
		const withProvider = `(${model.provider}) ${rightSide}`;
		if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) {
			rightSide = withProvider;
		}
	}

	const rightSideWidth = visibleWidth(rightSide);
	let statsLine;
	if (statsLeftWidth + minPadding + rightSideWidth <= width) {
		const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
		statsLine = statsLeft + padding + rightSide;
	} else {
		const availableForRight = width - statsLeftWidth - minPadding;
		if (availableForRight > 0) {
			const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
			const truncatedRightWidth = visibleWidth(truncatedRight);
			const padding = " ".repeat(
				Math.max(0, width - statsLeftWidth - truncatedRightWidth),
			);
			statsLine = statsLeft + padding + truncatedRight;
		} else {
			statsLine = statsLeft;
		}
	}

	// Dim the left and right parts separately: statsLeft may contain color
	// codes (context usage) whose reset would clear an outer dim wrapper.
	const dimStatsLeft = theme.fg("dim", statsLeft);
	const remainder = statsLine.slice(statsLeft.length);
	const dimRemainder = theme.fg("dim", remainder);
	const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
	return [pwdLine, dimStatsLeft + dimRemainder];
}

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function tokenSpeedExtension(pi) {
	let activeStream;
	let messageStats = [];
	let lastUiUpdateAt = 0;
	let lastFinalText;
	let lastSpeedText;
	let footer;
	let footerTui;

	function setStatus(ctx, text) {
		try {
			if (ctx.hasUI === false) return;
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// Footer updates must never break streaming.
		}
	}

	function requestFooterRender() {
		try {
			footerTui?.requestRender();
		} catch {
			// Footer updates must never break streaming.
		}
	}

	/**
	 * Replace pi's built-in footer with one that merges the token speed into
	 * the stats line. TUI-only; in other modes the status line is used.
	 */
	function installCustomFooter(ctx) {
		if (footer) return;
		if (ctx.hasUI === false) return;
		try {
			ctx.ui.setFooter((tui, theme, footerData) => {
				footerTui = tui;
				footer = {
					invalidate() {},
					dispose: footerData.onBranchChange(() => tui.requestRender()),
					render(width) {
						return renderMergedFooter({
							theme,
							footerData,
							ctx,
							speedText: lastSpeedText,
							width,
						});
					},
				};
				return footer;
			});
		} catch {
			// Custom footers are TUI-only; fall back to the status line.
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
		lastSpeedText = activeStream.thinking ? `${text} (thinking)` : text;
		setStatus(ctx, lastSpeedText);
	}

	pi.on("session_start", (_event, ctx) => {
		installCustomFooter(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		installCustomFooter(ctx);
		requestFooterRender();
	});

	pi.on("turn_start", (_event, ctx) => {
		installCustomFooter(ctx);
		requestFooterRender();
	});

	pi.on("turn_end", (_event, ctx) => {
		requestFooterRender();
	});

	pi.on("message_start", (_event, ctx) => {
		installCustomFooter(ctx);
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
		lastSpeedText = lastFinalText;
		setStatus(ctx, lastFinalText);
	});

	pi.registerCommand("speed", {
		description: "Show live token output speed for the last message and session totals",
		handler: async (_args, ctx) => {
			const summary = formatSpeedSummary(messageStats);
			if (!summary) {
				lastSpeedText = undefined;
				setStatus(ctx, undefined);
				requestFooterRender();
				if (ctx.hasUI !== false) {
					ctx.ui.notify(
						"No assistant output has been measured in this session yet.",
						"info",
					);
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
		lastSpeedText = undefined;
		footer = undefined;
		footerTui = undefined;
		try {
			if (ctx.hasUI !== false) ctx.ui.setFooter(undefined);
		} catch {
			// Footer updates must never break shutdown.
		}
		setStatus(ctx, undefined);
	});
}
