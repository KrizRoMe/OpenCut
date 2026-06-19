// Pure, UI-decoupled contracts for auto-trim (silence + disfluency removal).
// Everything here is plain data so the detection/planning logic can be unit
// tested without EditorCore, Web Workers, or the DOM.

// A single word with its timeline-aligned start/end (seconds). Mirrors the shape
// of TranscriptionSegment so the same Whisper output can feed both flows.
export interface TranscriptWord {
	text: string;
	start: number;
	end: number;
}

// A half-open time range [from, to) in TIMELINE seconds that should be removed.
// `reason` is kept for diagnostics/telemetry and for explaining cuts in the UI.
export type CutReason = "silence" | "repeat" | "restart";

export interface CutRange {
	from: number;
	to: number;
	reason: CutReason;
}

// User-facing configuration. Durations the user reasons about are expressed in
// milliseconds (matching the spec); the threshold is in dBFS. Defaults live in
// config.ts and follow the existing "exported constants" convention.
export interface AutoTrimConfig {
	// Silence detection
	removeSilences: boolean;
	silenceThresholdDb: number;
	// Pauses shorter than this are always kept (covers the <300ms and 300-700ms
	// "conservar" tiers).
	minSilenceMs: number;
	// A pause this long or longer is trimmed aggressively (the >2000ms tier).
	aggressiveSilenceMs: number;
	// Minimum pause left behind after trimming a silence (never cut to zero).
	keepAfterTrimMs: number;
	// Minimum pause left behind for aggressive (very long) silences. Defaults to
	// keepAfterTrimMs so the tiers are identical unless explicitly tightened.
	aggressiveKeepMs: number;

	// Disfluency detection (word-timestamp based)
	removeRepeatedWords: boolean;
	// Two identical consecutive words closer than this are treated as a stutter.
	repeatMaxGapMs: number;

	// Phrase restarts ("La aplicación permite… La aplicación permite exportar").
	// Heuristic and opt-in: off by default, conservative thresholds.
	removePhraseRestarts: boolean;
	restartMinWords: number;
	restartMaxWords: number;
	restartMaxGapMs: number;

	// Planning
	// Cuts closer than this are merged into one. Avoids fragmenting the clip into
	// dozens of micro-segments.
	mergeGapMs: number;
	// Cuts shorter than this are discarded (not worth a split).
	minCutMs: number;
}

// The output of the planner: the concrete ranges to delete plus a small summary
// the UI/toast can show ("removed 3.2s across 7 cuts").
export interface AutoTrimPlan {
	cuts: CutRange[];
	removedSeconds: number;
}
