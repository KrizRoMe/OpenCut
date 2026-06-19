import { describe, expect, test } from "bun:test";
import { wordsFromSegments } from "@/lib/silence/words-from-segments";

describe("wordsFromSegments", () => {
	test("splits a segment into contiguous words spanning its duration", () => {
		const words = wordsFromSegments([
			{ text: "hola mundo cruel", start: 1, end: 4 },
		]);
		expect(words.map((w) => w.text)).toEqual(["hola", "mundo", "cruel"]);
		expect(words[0].start).toBeCloseTo(1, 5);
		// contiguous: each word starts where the previous ended
		expect(words[1].start).toBeCloseTo(words[0].end, 5);
		expect(words[2].start).toBeCloseTo(words[1].end, 5);
		// spans the whole segment
		expect(words[words.length - 1].end).toBeCloseTo(4, 5);
	});

	test("preserves the gap between segments", () => {
		const words = wordsFromSegments([
			{ text: "uno", start: 0, end: 0.5 },
			{ text: "dos", start: 1.5, end: 2 },
		]);
		expect(words).toHaveLength(2);
		// the inter-segment gap survives (1.5 - 0.5 = 1s)
		expect(words[1].start - words[0].end).toBeCloseTo(1, 5);
	});

	test("skips empty segments", () => {
		const words = wordsFromSegments([
			{ text: "   ", start: 0, end: 1 },
			{ text: "ok", start: 1, end: 1.5 },
		]);
		expect(words.map((w) => w.text)).toEqual(["ok"]);
	});
});
