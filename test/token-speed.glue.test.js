import assert from "node:assert/strict";
import test from "node:test";

import tokenSpeedExtension, { STATUS_KEY } from "../extensions/token-speed.js";

function createHarness() {
	const statuses = [];
	const notifications = [];
	const commands = {};
	const handlers = {};

	const context = {
		hasUI: true,
		ui: {
			setStatus(key, text) {
				statuses.push({ key, text });
			},
			notify(message) {
				notifications.push(message);
			},
		},
	};

	const pi = {
		on(event, handler) {
			handlers[event] = handler;
		},
		registerCommand(name, definition) {
			commands[name] = definition;
		},
	};

	return { context, statuses, notifications, commands, handlers, pi };
}

function delta(type, content) {
	return { type, contentIndex: 0, delta: content, partial: { role: "assistant", content: [] } };
}

test("streaming turn drives the footer and session totals end to end", async () => {
	const harness = createHarness();
	tokenSpeedExtension(harness.pi);

	harness.handlers.message_start?.(
		{ message: { role: "assistant" } },
		harness.context,
	);

	// Simulate 1.8 seconds of streaming: four 40-char chunks at 600ms intervals.
	// 160 chars = 40 tokens over 1.8s, so the live footer should read 22 tok/s.
	const start = Date.now();
	let at = 0;
	const originalNow = Date.now;
	Date.now = () => start + at;
	try {
		for (const chunk of ["a".repeat(40), "a".repeat(40), "a".repeat(40), "a".repeat(40)]) {
			at += 600;
			harness.handlers.message_update?.(
				{ message: { role: "assistant" }, assistantMessageEvent: delta("text_delta", chunk) },
				harness.context,
			);
		}

		const live = harness.statuses.at(-1);
		assert.equal(live.key, STATUS_KEY);
		assert.equal(live.text, "22 tok/s");

		// 2,880 provider tokens over the same 1.8s duration = exactly 1,600 tok/s.
		harness.handlers.message_end?.(
			{
				message: {
					role: "assistant",
					usage: { output: 2880, input: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2880, cost: {} },
				},
			},
			harness.context,
		);
	} finally {
		Date.now = originalNow;
	}

	// Final status uses exact provider tokens.
	const final = harness.statuses.at(-1);
	assert.equal(final.key, STATUS_KEY);
	assert.match(final.text, /^avg 1600 tok\/s \| 2,880 tok \| 1\.8s$/);

	// The /speed command reports session totals.
	await harness.commands.speed.handler(undefined, harness.context);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0], /Session: 1 reply \| 2,880 tok output/);
	assert.match(harness.notifications[0], /Last: avg 1600 tok\/s \| 2,880 tok \| 1\.8s/);

	harness.handlers.session_shutdown?.({}, harness.context);
});

test("session shutdown clears the footer", async () => {
	const harness = createHarness();
	tokenSpeedExtension(harness.pi);

	harness.handlers.session_start?.({}, harness.context);
	harness.handlers.message_start?.({ message: { role: "assistant" } }, harness.context);
	harness.handlers.message_update?.(
		{ message: { role: "assistant" }, assistantMessageEvent: delta("text_delta", "abc") },
		harness.context,
	);
	harness.handlers.session_shutdown?.({}, harness.context);

	assert.equal(harness.statuses.at(-1).text, undefined);

	// Totals reset after shutdown, so /speed reports no data.
	const before = harness.notifications.length;
	await harness.commands.speed.handler(undefined, harness.context);
	assert.equal(harness.notifications.length, before + 1);
	assert.match(harness.notifications[0], /No assistant output/);
});

test("speed command guards against missing UI", async () => {
	const harness = createHarness();
	tokenSpeedExtension(harness.pi);

	harness.context.hasUI = false;
	await harness.commands.speed.handler(undefined, harness.context);
	assert.equal(harness.notifications.length, 0);
	assert.equal(harness.statuses.length, 0);
});