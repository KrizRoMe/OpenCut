import type { AutoTrimConfig, CutRange, TranscriptWord } from "./types";

// Lowercase and strip punctuation/whitespace so "Yo," and "yo" compare equal.
// Whisper word chunks usually carry a leading space and trailing punctuation.
export function normalizeWord(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function gapMs(a: TranscriptWord, b: TranscriptWord): number {
	return (b.start - a.end) * 1000;
}

// "yo yo creo", "la la aplicación": identical consecutive words spoken close
// together. Removes every duplicate except the last in a run by cutting the
// earlier word's span up to where the next word begins.
export function detectRepeatedWordCuts({
	words,
	config,
}: {
	words: TranscriptWord[];
	config: AutoTrimConfig;
}): CutRange[] {
	if (!config.removeRepeatedWords) return [];
	const cuts: CutRange[] = [];
	for (let i = 0; i < words.length - 1; i++) {
		const current = normalizeWord(words[i].text);
		const next = normalizeWord(words[i + 1].text);
		if (!current || current !== next) continue;
		if (gapMs(words[i], words[i + 1]) >= config.repeatMaxGapMs) continue;
		cuts.push({
			from: words[i].start,
			to: words[i + 1].start,
			reason: "repeat",
		});
	}
	return cuts;
}

// Phrase restarts: a short run of words immediately repeated, e.g.
// "la aplicación permite … la aplicación permite exportar". Conservative and
// opt-in (greedy on the longest matching prefix, bounded by config). Removes the
// FIRST (incomplete) occurrence.
export function detectPhraseRestartCuts({
	words,
	config,
}: {
	words: TranscriptWord[];
	config: AutoTrimConfig;
}): CutRange[] {
	if (!config.removePhraseRestarts) return [];
	const norms = words.map((word) => normalizeWord(word.text));
	const cuts: CutRange[] = [];

	let i = 0;
	while (i < words.length) {
		let matched = 0;
		for (let k = config.restartMaxWords; k >= config.restartMinWords; k--) {
			if (i + 2 * k > words.length) continue;
			let equal = true;
			for (let j = 0; j < k; j++) {
				if (!norms[i + j] || norms[i + j] !== norms[i + k + j]) {
					equal = false;
					break;
				}
			}
			if (!equal) continue;
			// Gap at the seam between the first run and its repetition.
			if (gapMs(words[i + k - 1], words[i + k]) >= config.restartMaxGapMs) {
				continue;
			}
			cuts.push({
				from: words[i].start,
				to: words[i + k].start,
				reason: "restart",
			});
			matched = k;
			break;
		}
		i += matched > 0 ? matched : 1;
	}

	return cuts;
}

export function detectDisfluencyCuts({
	words,
	config,
}: {
	words: TranscriptWord[];
	config: AutoTrimConfig;
}): CutRange[] {
	return [
		...detectRepeatedWordCuts({ words, config }),
		...detectPhraseRestartCuts({ words, config }),
	];
}
