import { describe, expect, test } from "bun:test";
import {
	detectPhraseRestartCuts,
	detectRepeatedWordCuts,
	normalizeWord,
} from "@/lib/silence/detect-disfluencies";
import { resolveAutoTrimConfig } from "@/lib/silence/config";
import type { TranscriptWord } from "@/lib/silence/types";

const w = (text: string, start: number, end: number): TranscriptWord => ({
	text,
	start,
	end,
});

describe("normalizeWord", () => {
	test("lowercases and strips punctuation", () => {
		expect(normalizeWord(" Yo,")).toBe("yo");
		expect(normalizeWord("¡Hola!")).toBe("hola");
	});
});

describe("detectRepeatedWordCuts", () => {
	test("cuts the earlier duplicate when spoken close together", () => {
		const words = [w(" yo", 0, 0.2), w(" yo", 0.3, 0.5), w(" creo", 0.6, 0.9)];
		const cuts = detectRepeatedWordCuts({
			words,
			config: resolveAutoTrimConfig(),
		});
		expect(cuts).toHaveLength(1);
		expect(cuts[0].reason).toBe("repeat");
		expect(cuts[0].from).toBeCloseTo(0, 5);
		expect(cuts[0].to).toBeCloseTo(0.3, 5);
	});

	test("ignores duplicates separated by a long gap", () => {
		const words = [w("ya", 0, 0.2), w("ya", 1.5, 1.7)];
		const cuts = detectRepeatedWordCuts({
			words,
			config: resolveAutoTrimConfig(),
		});
		expect(cuts).toHaveLength(0);
	});

	test("handles a triple, keeping only the last", () => {
		const words = [w("no", 0, 0.2), w("no", 0.3, 0.5), w("no", 0.6, 0.8)];
		const cuts = detectRepeatedWordCuts({
			words,
			config: resolveAutoTrimConfig(),
		});
		expect(cuts).toHaveLength(2);
	});
});

describe("detectPhraseRestartCuts", () => {
	const restartConfig = resolveAutoTrimConfig({ removePhraseRestarts: true });

	test("removes the incomplete first occurrence of a restarted phrase", () => {
		const words = [
			w("la", 0, 0.2),
			w("aplicacion", 0.25, 0.6),
			w("permite", 0.65, 1.0),
			w("la", 1.1, 1.3),
			w("aplicacion", 1.35, 1.7),
			w("permite", 1.75, 2.1),
			w("exportar", 2.15, 2.6),
		];
		const cuts = detectPhraseRestartCuts({ words, config: restartConfig });
		expect(cuts).toHaveLength(1);
		expect(cuts[0].reason).toBe("restart");
		expect(cuts[0].from).toBeCloseTo(0, 5);
		expect(cuts[0].to).toBeCloseTo(1.1, 5);
	});

	test("is off by default", () => {
		const words = [
			w("la", 0, 0.2),
			w("app", 0.25, 0.6),
			w("la", 0.7, 0.9),
			w("app", 0.95, 1.3),
		];
		const cuts = detectPhraseRestartCuts({
			words,
			config: resolveAutoTrimConfig(),
		});
		expect(cuts).toHaveLength(0);
	});
});
