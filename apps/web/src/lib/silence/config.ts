import type { AutoTrimConfig } from "./types";

// Initial configuration. Follows the project's existing "exported constants as
// defaults" convention (cf. caption-defaults.ts, audio-constants.ts).
export const DEFAULT_AUTO_TRIM_CONFIG: AutoTrimConfig = {
	removeSilences: true,
	silenceThresholdDb: -40,
	minSilenceMs: 700,
	aggressiveSilenceMs: 2000,
	keepAfterTrimMs: 250,
	aggressiveKeepMs: 250,

	removeRepeatedWords: true,
	repeatMaxGapMs: 500,

	// Opt-in and conservative by default (heuristic, false-positive prone).
	removePhraseRestarts: false,
	restartMinWords: 2,
	restartMaxWords: 6,
	restartMaxGapMs: 800,

	mergeGapMs: 120,
	// Word-level cuts (a single repeat) are inherently short, so keep this small —
	// it only exists to drop sub-frame slivers.
	minCutMs: 40,
};

// Merge a partial override (from the UI or a skill payload) onto the defaults.
// Keeps callers from having to specify the whole config.
export function resolveAutoTrimConfig(
	overrides?: Partial<AutoTrimConfig>,
): AutoTrimConfig {
	return { ...DEFAULT_AUTO_TRIM_CONFIG, ...(overrides ?? {}) };
}
