import { describe, expect, test } from "bun:test";
import { detectSilenceCuts } from "@/lib/silence/detect-silence";
import { resolveAutoTrimConfig } from "@/lib/silence/config";

const SAMPLE_RATE = 16000;

// Build a mono buffer where each [startSec, endSec] region is filled with a
// constant amplitude (0 = silence). Index i maps to timeline second i/sr.
function buildSamples(
	regions: Array<{ start: number; end: number; amp: number }>,
	totalSeconds: number,
): Float32Array {
	const samples = new Float32Array(Math.ceil(totalSeconds * SAMPLE_RATE));
	for (const { start, end, amp } of regions) {
		const from = Math.floor(start * SAMPLE_RATE);
		const to = Math.floor(end * SAMPLE_RATE);
		for (let i = from; i < to; i++) samples[i] = amp;
	}
	return samples;
}

describe("detectSilenceCuts", () => {
	test("trims a long silence, keeping keepAfterTrimMs at the start", () => {
		// speech 0-1s, silence 1-2s, speech 2-3s
		const samples = buildSamples(
			[
				{ start: 0, end: 1, amp: 0.5 },
				{ start: 2, end: 3, amp: 0.5 },
			],
			3,
		);
		const config = resolveAutoTrimConfig();
		const cuts = detectSilenceCuts({
			samples,
			sampleRate: SAMPLE_RATE,
			spanStart: 0,
			spanEnd: 3,
			config,
		});

		expect(cuts).toHaveLength(1);
		// keepAfterTrimMs = 250 -> cut starts ~1.25s and ends at the silence end ~2s
		expect(cuts[0].reason).toBe("silence");
		expect(cuts[0].from).toBeGreaterThanOrEqual(1.2);
		expect(cuts[0].from).toBeLessThanOrEqual(1.3);
		expect(cuts[0].to).toBeGreaterThanOrEqual(1.95);
		expect(cuts[0].to).toBeLessThanOrEqual(2.05);
	});

	test("keeps short pauses below minSilenceMs", () => {
		// 300ms silence between speech -> below the 700ms default, kept
		const samples = buildSamples(
			[
				{ start: 0, end: 1, amp: 0.5 },
				{ start: 1.3, end: 2.3, amp: 0.5 },
			],
			2.3,
		);
		const cuts = detectSilenceCuts({
			samples,
			sampleRate: SAMPLE_RATE,
			spanStart: 0,
			spanEnd: 2.3,
			config: resolveAutoTrimConfig(),
		});
		expect(cuts).toHaveLength(0);
	});

	test("respects removeSilences=false", () => {
		const samples = buildSamples([{ start: 0, end: 1, amp: 0.5 }], 3);
		const cuts = detectSilenceCuts({
			samples,
			sampleRate: SAMPLE_RATE,
			spanStart: 0,
			spanEnd: 3,
			config: resolveAutoTrimConfig({ removeSilences: false }),
		});
		expect(cuts).toHaveLength(0);
	});

	test("only analyses within the given span", () => {
		// Loud only outside [1,2]; inside the span it is pure silence but the span
		// is shorter than minSilence so nothing is cut.
		const samples = buildSamples(
			[
				{ start: 0, end: 1, amp: 0.5 },
				{ start: 2, end: 3, amp: 0.5 },
			],
			3,
		);
		const cuts = detectSilenceCuts({
			samples,
			sampleRate: SAMPLE_RATE,
			spanStart: 1,
			spanEnd: 1.5,
			config: resolveAutoTrimConfig(),
		});
		expect(cuts).toHaveLength(0);
	});
});
