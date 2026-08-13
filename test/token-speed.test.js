import assert from "node:assert/strict";
import test from "node:test";

import tokenSpeedExtension, {
	CHARS_PER_TOKEN,
	STATUS_KEY,
	deltaContribution,
	estimateTokens,
	formatAvgStatus,
	formatSpeed,
	formatSpeedSummary,
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

test("formats the message average shown in the footer", () => {
	assert.equal(
		formatAvgStatus({ tokens: 1_024, durationMs: 67_300 }),
		"avg 15 tok/s | 1,024 tok | 67.3s",
	);
	assert.equal(formatAvgStatus({ tokens: 12, durationMs: 8_000 }), "avg 1.5 tok/s | 12 tok | 8.0s");
	assert.equal(formatAvgStatus({ tokens: 0, durationMs: 5_000 }), "avg <0.1 tok/s | 0 tok | 5.0s");
	assert.equal(formatAvgStatus({ tokens: 10, durationMs: 0 }), "avg <0.1 tok/s | 10 tok | 0.0s");
	assert.equal(formatAvgStatus(undefined), undefined);
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