import type { TranscriptWord } from "./types";

// Derive per-word timings from segment-level transcription.
//
// Whisper's reliable, widely-supported output is segment/phrase level
// (`return_timestamps: true`) — the same the captions flow uses. Word-level
// timestamps (`"word"`) need a model exported with cross-attentions, which the
// app's models don't have and which proved unreliable in practice.
//
// We split each segment into tokens and spread the segment's duration across
// them proportionally to token length. Words inside a segment end up contiguous
// (no gaps); real gaps appear BETWEEN segments — which is exactly what the
// disfluency heuristics need (repeats land with ~0 gap; isolated tokens land
// at segment boundaries with a real gap).
export function wordsFromSegments(
	segments: Array<{ text: string; start: number; end: number }>,
): TranscriptWord[] {
	const words: TranscriptWord[] = [];

	for (const segment of segments) {
		const tokens = segment.text.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;

		const duration = Math.max(0, segment.end - segment.start);
		const totalChars =
			tokens.reduce((sum, token) => sum + token.length, 0) || tokens.length;

		let cursor = segment.start;
		for (const token of tokens) {
			const fraction = (token.length || 1) / totalChars;
			const tokenDuration = duration * fraction;
			words.push({
				text: token,
				start: cursor,
				end: cursor + tokenDuration,
			});
			cursor += tokenDuration;
		}
	}

	return words;
}
