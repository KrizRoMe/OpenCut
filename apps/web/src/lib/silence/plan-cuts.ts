import type { AutoTrimConfig, AutoTrimPlan, CutRange } from "./types";

// Combine raw cuts from every detector into a clean, ordered, non-overlapping
// set of ranges ready to delete. Pure and deterministic.
//
//  - clamp to the target clip span
//  - sort and merge ranges closer than mergeGapMs (avoids fragmenting the clip)
//  - drop slivers shorter than minCutMs (not worth a split)
export function planAutoTrim({
	cuts,
	spanStart,
	spanEnd,
	config,
}: {
	cuts: CutRange[];
	spanStart: number;
	spanEnd: number;
	config: AutoTrimConfig;
}): AutoTrimPlan {
	const clamped: CutRange[] = [];
	for (const cut of cuts) {
		const from = Math.max(spanStart, cut.from);
		const to = Math.min(spanEnd, cut.to);
		if (to - from > 0) clamped.push({ ...cut, from, to });
	}

	clamped.sort((a, b) => a.from - b.from);

	const mergeGap = config.mergeGapMs / 1000;
	const merged: CutRange[] = [];
	for (const cut of clamped) {
		const last = merged[merged.length - 1];
		if (last && cut.from <= last.to + mergeGap) {
			last.to = Math.max(last.to, cut.to);
		} else {
			merged.push({ ...cut });
		}
	}

	const minCut = config.minCutMs / 1000;
	const finalCuts = merged.filter((cut) => cut.to - cut.from >= minCut);
	const removedSeconds = finalCuts.reduce(
		(total, cut) => total + (cut.to - cut.from),
		0,
	);

	return { cuts: finalCuts, removedSeconds };
}
