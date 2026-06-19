// Applies planned cut ranges to a single timeline element by reusing the exact
// same split→split→delete pattern as the `delete_segment` skill action, plus the
// editor's existing ripple mechanism to close the gaps left behind.
//
// This is the only piece of the auto-trim feature that touches EditorCore, so it
// lives outside the pure (unit-tested) module above.

import type { EditorCore } from "@/core";
import { TICKS_PER_SECOND } from "@/lib/wasm/ticks";
import type { CutRange } from "./types";

export function applyAutoTrimCuts({
	editor,
	trackId,
	elementId,
	cuts,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
	// Timeline-second ranges, assumed already clamped/merged/sorted ascending.
	cuts: CutRange[];
}): number {
	if (cuts.length === 0) return 0;

	const toTicks = (seconds: number): number =>
		Math.round(seconds * TICKS_PER_SECOND);

	// Enable ripple so each inner deletion closes its gap (mirrors the manual
	// editor's "ripple delete"). Restore the previous flag afterwards.
	const previousRipple = editor.command.isRippleEnabled;
	editor.command.isRippleEnabled = true;

	let applied = 0;
	try {
		// Process from the end backwards so earlier ranges keep valid timeline
		// coordinates after later deletions shift everything to their right.
		for (const cut of [...cuts].sort((a, b) => b.from - a.from)) {
			const from = toTicks(cut.from);
			const to = toTicks(cut.to);
			if (to <= from) continue;

			// Cut at the end first (keeps the left part stable under `elementId`),
			// then at the start; the piece returned by the second split is the
			// [from, to) segment to delete.
			editor.timeline.splitElements({
				elements: [{ trackId, elementId }],
				splitTime: to,
			});
			const middle = editor.timeline.splitElements({
				elements: [{ trackId, elementId }],
				splitTime: from,
			});
			if (middle.length === 0) continue;
			editor.timeline.deleteElements({ elements: middle });
			applied++;
		}
	} finally {
		editor.command.isRippleEnabled = previousRipple;
	}

	return applied;
}
