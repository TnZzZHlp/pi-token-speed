import assert from "node:assert/strict";
import test from "node:test";

import tokenSpeedExtension, {
	CHARS_PER_TOKEN,
	SPEED_WINDOW_MS,
	STATUS_KEY,
	deltaContribution,
	estimateTokens,
	formatFinalStatus,
	formatLiveStatus,
	formatSpeed,
	formatSpeedSummary,
	measureSpeed,
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

function makeSamples(pairs) {
	return pairs.map(([at, tokens]) => ({ at, tokens }));
}

test("measures speed over the rolling window", () => {
	const samples = makeSamples([
		[0, 10],
		[1_000, 10],
	]);
	assert.equal(measureSpeed(samples, 1_000, SPEED_WINDOW_MS), 20);

	const old = makeSamples([
		[0, 100],
		[1_000, 0],
	]);
	assert.equal(measureSpeed(old, 5_000, 3_000), 0);

	const mixed = makeSamples([
		[0, 100],
		[3_000, 10],
		[4_000, 10],
	]);
	assert.equal(Math.round(measureSpeed(mixed, 4_500, 3_000)), 20);

	assert.equal(measureSpeed([], 1_000, 3_000), 0);
	assert.equal(measureSpeed(makeSamples([[0, 10]]), 500, 3_000), 0);
	assert.equal(measureSpeed(undefined, 500), 0);
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

test("formats live footer status", () => {
	assert.equal(formatLiveStatus({ tokensPerSecond: 12.4, thinking: false }), "12 tok/s");
	assert.equal(formatLiveStatus({ tokensPerSecond: 1.5, thinking: true }), "1.5 tok/s (thinking)");
	assert.equal(formatLiveStatus({ tokensPerSecond: 0, thinking: false }), "<0.1 tok/s");
	assert.equal(formatLiveStatus({ tokensPerSecond: undefined }), undefined);
});

test("formats final footer status with exact tokens", () => {
	assert.equal(
		formatFinalStatus({ tokens: 1_024, durationMs: 67_300 }),
		"avg 15 tok/s | 1,024 tok | 67.3s",
	);
	assert.equal(
		formatFinalStatus({ tokens: 12, durationMs: 8_000 }),
		"avg 1.5 tok/s | 12 tok | 8.0s",
	);
	assert.equal(formatFinalStatus({ tokens: 0, durationMs: 5_000 }), "avg <0.1 tok/s | 0 tok | 5.0s");
	assert.equal(formatFinalStatus(undefined), undefined);
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