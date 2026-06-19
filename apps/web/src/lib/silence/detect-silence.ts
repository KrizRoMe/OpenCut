import { findEnergyIntervals } from "./frame-energy";
import type { AutoTrimConfig, CutRange } from "./types";

// Turn silent intervals into cut ranges following the spec's duration tiers:
//   < minSilenceMs            -> keep (no cut)
//   minSilenceMs..aggressive  -> partial trim, leave keepAfterTrimMs
//   >= aggressiveSilenceMs    -> aggressive trim, leave aggressiveKeepMs
// The retained pause is kept at the START of the gap (speech ends, brief pause,
// then the next utterance follows immediately after the cut).
export function detectSilenceCuts({
	samples,
	sampleRate,
	spanStart,
	spanEnd,
	config,
}: {
	samples: Float32Array;
	sampleRate: number;
	spanStart: number;
	spanEnd: number;
	config: AutoTrimConfig;
}): CutRange[] {
	if (!config.removeSilences) return [];

	const intervals = findEnergyIntervals({
		samples,
		sampleRate,
		spanStart,
		spanEnd,
		thresholdDb: config.silenceThresholdDb,
		want: "silent",
	});

	const cuts: CutRange[] = [];
	for (const { start, end } of intervals) {
		const durationMs = (end - start) * 1000;
		if (durationMs < config.minSilenceMs) continue;

		const keepMs =
			durationMs >= config.aggressiveSilenceMs
				? config.aggressiveKeepMs
				: config.keepAfterTrimMs;
		const from = start + keepMs / 1000;
		if (end - from <= 0) continue;

		cuts.push({ from, to: end, reason: "silence" });
	}

	return cuts;
}
