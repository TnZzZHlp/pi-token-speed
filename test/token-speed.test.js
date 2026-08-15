import assert from "node:assert/strict";
import test from "node:test";

import tokenSpeedExtension, {
	CHARS_PER_TOKEN,
	STATUS_KEY,
	buildStatsParts,
	deltaContribution,
	estimateTokens,
	formatAvgSpeed,
	formatSpeed,
	formatSpeedSummary,
	formatTokens,
	renderMergedFooter,
	truncateToWidth,
	visibleWidth,
} from "../extensions/token-speed.js";

test("estimates tokens from characters", () => {
	assert.equal(estimateTokens(0), 0);
	assert.equal(estimateTokens(1), 1);
	assert.equal(estimateTokens(CHARS_PER_TOKEN), 1);
	assert.equal(estimateTokens(CHARS_PER_TOKEN + 1), 2);
	assert.equal(estimateTokens(-5), 0);
});

test("counts streaming deltas and ignores non-delta events", () => {
	assert.deepEqual(deltaContribution({ type: "text_delta", delta: "hello" }), {
		chars: 5,
		tokens: 2,
	});
	assert.deepEqual(deltaContribution({ type: "thinking_delta", delta: "abcd" }), {
		chars: 4,
		tokens: 1,
	});
	assert.deepEqual(deltaContribution({ type: "toolcall_delta", delta: "{" }), {
		chars: 1,
		tokens: 1,
	});
	assert.deepEqual(deltaContribution({ type: "start", partial: {} }), { chars: 0, tokens: 0 });
	assert.deepEqual(deltaContribution({ type: "text_start", contentIndex: 0 }), {
		chars: 0,
		tokens: 0,
	});
	assert.deepEqual(deltaContribution({ type: "done", message: {} }), { chars: 0, tokens: 0 });
	assert.deepEqual(deltaContribution({ type: "text_delta", delta: 42 }), { chars: 0, tokens: 0 });
	assert.deepEqual(deltaContribution(undefined), { chars: 0, tokens: 0 });
});

test("formats speed values", () => {
	assert.equal(formatSpeed(0), "<0.1");
	assert.equal(formatSpeed(0.04), "<0.1");
	assert.equal(formatSpeed(1.5), "1.5");
	assert.equal(formatSpeed(12.4), "12");
	assert.equal(formatSpeed(102.9), "103");
	assert.equal(formatSpeed(undefined), "<0.1");
	assert.equal(formatSpeed(Number.NaN), "<0.1");
});

test("formats the average speed and duration shown in the footer", () => {
	assert.equal(formatAvgSpeed({ tokens: 1_024, durationMs: 67_300 }), "15 tok/s | 67.3s");
	assert.equal(formatAvgSpeed({ tokens: 12, durationMs: 8_000 }), "1.5 tok/s | 8.0s");
	assert.equal(formatAvgSpeed({ tokens: 10, durationMs: 0 }), undefined);
	assert.equal(formatAvgSpeed({ tokens: 0, durationMs: 5_000 }), undefined);
	assert.equal(formatAvgSpeed(undefined), undefined);
});

test("formats session summaries", () => {
	assert.equal(formatSpeedSummary(undefined), undefined);
	assert.equal(formatSpeedSummary([]), undefined);

	const single = formatSpeedSummary([{ tokens: 1_024, durationMs: 67_300 }]);
	assert.equal(
		single.text,
		"Session: 1 reply | 1,024 tok output | avg 15 tok/s",
	);
	assert.deepEqual(single.detail, {
		messages: 1,
		tokens: 1_024,
		durationMs: 67_300,
		measured: 1,
	});

	const multiple = formatSpeedSummary([
		{ tokens: 1_000, durationMs: 50_000 },
		{ tokens: 500, durationMs: 25_000 },
		{ tokens: 0, durationMs: 0 },
	]);
	assert.equal(
		multiple.text,
		"Session: 3 replies | 1,500 tok output | avg 20 tok/s",
	);
	assert.deepEqual(multiple.detail, {
		messages: 3,
		tokens: 1_500,
		durationMs: 75_000,
		measured: 2,
	});
});

test("exports the extension factory", () => {
	assert.equal(typeof tokenSpeedExtension, "function");
	assert.equal(STATUS_KEY, "token-speed");
});

test("formats token counts like the built-in footer", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_234), "1.2k");
	assert.equal(formatTokens(12_345), "12k");
	assert.equal(formatTokens(234_567), "235k");
	assert.equal(formatTokens(1_234_567), "1.2M");
	assert.equal(formatTokens(12_345_678), "12M");
});

test("measures visible width without ANSI codes and with wide characters", () => {
	assert.equal(visibleWidth("abc"), 3);
	assert.equal(visibleWidth("\x1b[2mabc\x1b[39m"), 3);
	assert.equal(visibleWidth("你好"), 4);
	assert.equal(visibleWidth("a你b"), 4);
	assert.equal(visibleWidth(""), 0);
});

test("truncates to a visible width and keeps ANSI codes intact", () => {
	assert.equal(truncateToWidth("hello world", 5, "..."), "he...");
	assert.equal(truncateToWidth("hello", 8, "..."), "hello"); // fits, no suffix
	assert.equal(truncateToWidth("hello", 5), "hello");
	assert.equal(truncateToWidth("hello world", 3, "..."), "...");
	assert.equal(truncateToWidth("你a你a", 4, "~"), "你a~");
	// ANSI codes are preserved and do not consume width.
	assert.equal(truncateToWidth("\x1b[2mhello\x1b[39m", 7, "..."), "\x1b[2mhell\x1b[39m...");
});

test("builds stats parts with the speed merged into the same line", () => {
	const parts = buildStatsParts({
		totals: { input: 5_000, output: 3_000, cacheRead: 1_000, cacheWrite: 0, cost: 0.0123 },
		cacheHitRate: 16.666,
		contextPercentDisplay: "42.1%/200k",
		speedText: "15 tok/s | 67.3s",
		statusTexts: ["plan mode"],
	});
	assert.deepEqual(parts, [
		"↑5.0k",
		"↓3.0k",
		"R1.0k",
		"CH16.7%",
		"$0.012",
		"42.1%/200k",
		"• 15 tok/s | 67.3s",
		"• plan mode",
	]);

	// No cost when zero, no speed when not streaming, no cache rate without cache.
	assert.deepEqual(
		buildStatsParts({
			totals: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0 },
			cacheHitRate: undefined,
			contextPercentDisplay: "0.0%/200k",
			speedText: undefined,
		}),
		["↓100", "0.0%/200k"],
	);
});

function createFakeFooterParts() {
	const theme = {
		fg(color, text) {
			const ansi = { dim: "\x1b[2m", error: "\x1b[31m", warning: "\x1b[33m" }[color] ?? `\x1b[${color}m`;
			return `${ansi}${text}\x1b[39m`;
		},
	};
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 5_000,
					output: 3_000,
					cacheRead: 1_000,
					cacheWrite: 0,
					cost: { total: 0.0123 },
				},
			},
		},
	];
	const statuses = new Map([
		[STATUS_KEY, "should not be listed separately"],
		["plan-mode", "plan mode"],
	]);
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
	};
	const ctx = {
		sessionManager: {
			getEntries: () => entries,
			getCwd: () => "/home/user/project",
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ percent: 42.1, contextWindow: 200_000 }),
		model: { id: "my-model", provider: "openai", reasoning: true, contextWindow: 200_000 },
		thinkingLevel: "high",
	};
	return { theme, footerData, ctx };
}

test("merged footer renders pwd and one stats line containing the speed", () => {
	const { theme, footerData, ctx } = createFakeFooterParts();
	const lines = renderMergedFooter({
		theme,
		footerData,
		ctx,
		speedText: "15 tok/s | 67.3s",
		width: 200,
	});

	assert.equal(lines.length, 2);
	// HOME is not /home/user in the test environment, so no ~ shortening.
	assert.match(lines[0], /^\x1b\[2m\/home\/user\/project \(main\)\x1b\[39m$/);

	const statsLine = lines[1];
	// Speed shares the stats line with the other footer information.
	assert.match(statsLine, /↑5\.0k ↓3\.0k R1\.0k CH16\.7% \$0\.012 42\.1%\/200k/);
	assert.match(statsLine, /• 15 tok\/s \| 67\.3s/);
	// Other extensions' statuses are merged in; our own status key is not.
	assert.match(statsLine, /• plan mode/);
	assert.doesNotMatch(statsLine, /should not be listed separately/);
	// Model name stays right-aligned with the thinking level.
	assert.match(statsLine, /my-model • high\x1b\[39m$/);
});

test("merged footer drops the speed part when nothing is streaming", () => {
	const { theme, footerData, ctx } = createFakeFooterParts();
	const lines = renderMergedFooter({
		theme,
		footerData,
		ctx,
		speedText: undefined,
		width: 200,
	});
	assert.equal(lines.length, 2);
	assert.doesNotMatch(lines[1], /tok\/s/);
	// Other extensions' statuses are still shown on the same line.
	assert.match(lines[1], /• plan mode/);
});

test("merged footer colors the context usage and truncates to the width", () => {
	const { theme, footerData, ctx } = createFakeFooterParts();
	ctx.getContextUsage = () => ({ percent: 95.2, contextWindow: 200_000 });
	const lines = renderMergedFooter({
		theme,
		footerData,
		ctx,
		speedText: "15 tok/s | 67.3s",
		width: 200,
	});
	assert.match(lines[1], /\x1b\[31m95\.2%\/200k\x1b\[39m/);

	const narrow = renderMergedFooter({
		theme,
		footerData,
		ctx,
		speedText: "15 tok/s | 67.3s",
		width: 20,
	});
	assert.equal(narrow.length, 2);
	assert.ok(visibleWidth(narrow[0]) <= 20);
	assert.ok(visibleWidth(narrow[1]) <= 20);
});