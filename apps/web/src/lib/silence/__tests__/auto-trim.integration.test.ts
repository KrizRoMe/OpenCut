import { describe, expect, test } from "bun:test";
import {
	detectDisfluencyCuts,
	detectSilenceCuts,
	planAutoTrim,
	resolveAutoTrimConfig,
} from "@/lib/silence";
import type { CutRange, TranscriptWord } from "@/lib/silence/types";

const SAMPLE_RATE = 16000;

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

const w = (text: string, start: number, end: number): TranscriptWord => ({
	text,
	start,
	end,
});

// End-to-end of the PURE pipeline: silence detection + disfluency detection ->
// planner. (Timeline mutation lives in apply-cuts.ts and needs EditorCore.)
function runPipeline({
	samples,
	words,
	spanStart,
	spanEnd,
	overrides,
}: {
	samples: Float32Array;
	words: TranscriptWord[];
	spanStart: number;
	spanEnd: number;
	overrides?: Parameters<typeof resolveAutoTrimConfig>[0];
}) {
	const config = resolveAutoTrimConfig(overrides);
	const cuts: CutRange[] = [
		...detectSilenceCuts({
			samples,
			sampleRate: SAMPLE_RATE,
			spanStart,
			spanEnd,
			config,
		}),
		...detectDisfluencyCuts({ words, config }),
	];
	return planAutoTrim({ cuts, spanStart, spanEnd, config });
}

describe("auto-trim pipeline", () => {
	test("combines a repeated word and a long silence into two cuts", () => {
		const samples = buildSamples(
			[
				{ start: 0, end: 1, amp: 0.5 },
				{ start: 2, end: 3, amp: 0.5 },
			],
			3,
		);
		const words = [
			w(" hola", 0, 0.4),
			w(" hola", 0.5, 0.9),
			w(" mundo", 2.2, 2.6),
		];
		const plan = runPipeline({ samples, words, spanStart: 0, spanEnd: 3 });

		expect(plan.cuts).toHaveLength(2);
		const reasons = plan.cuts.map((c) => c.reason).sort();
		expect(reasons).toEqual(["repeat", "silence"]);
		expect(plan.removedSeconds).toBeGreaterThan(1);
	});

	test("edge: noisy room tone above threshold is not cut", () => {
		// amp 0.02 ~= -34 dBFS, above the -40 default -> not silence
		const samples = buildSamples(
			[
				{ start: 0, end: 1, amp: 0.5 },
				{ start: 1, end: 2, amp: 0.02 },
				{ start: 2, end: 3, amp: 0.5 },
			],
			3,
		);
		const plan = runPipeline({ samples, words: [], spanStart: 0, spanEnd: 3 });
		expect(plan.cuts).toHaveLength(0);
	});

	test("edge: fast speech with tiny gaps still detects repeats", () => {
		const words = [w("y", 0, 0.08), w("y", 0.12, 0.2), w("listo", 0.24, 0.5)];
		const plan = runPipeline({
			samples: new Float32Array(0),
			words,
			spanStart: 0,
			spanEnd: 0.5,
		});
		expect(plan.cuts).toHaveLength(1);
		expect(plan.cuts[0].reason).toBe("repeat");
	});

	test("edge: slow speech with natural pauses keeps everything", () => {
		// Words far apart, no identical neighbours -> no disfluency cuts; gaps are
		// modelled as silence below minSilence so nothing is removed here.
		const words = [w("hola", 0, 0.4), w("mundo", 1.0, 1.4)];
		const plan = runPipeline({
			samples: new Float32Array(0),
			words,
			spanStart: 0,
			spanEnd: 1.4,
		});
		expect(plan.cuts).toHaveLength(0);
	});
});
