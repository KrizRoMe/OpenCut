// Shared frame-energy scanning used by both silence and filled-pause detection.
// Pure: walks a mono PCM buffer in fixed frames, computes RMS per frame, and
// groups consecutive frames that are either below ("silent") or at/above
// ("audible") a dBFS threshold into intervals (in TIMELINE seconds).

export interface EnergyInterval {
	start: number;
	end: number;
}

// Frame size. 20ms resolves word/pause boundaries with a stable RMS estimate.
export const FRAME_MS = 20;

function rmsToDb(rms: number): number {
	if (rms <= 1e-7) return -Infinity;
	return 20 * Math.log10(rms);
}

export function findEnergyIntervals({
	samples,
	sampleRate,
	spanStart,
	spanEnd,
	thresholdDb,
	want,
	frameMs = FRAME_MS,
}: {
	samples: Float32Array;
	sampleRate: number;
	spanStart: number;
	spanEnd: number;
	thresholdDb: number;
	// "silent": frames below the threshold. "audible": frames at/above it.
	want: "silent" | "audible";
	frameMs?: number;
}): EnergyInterval[] {
	const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
	const startSample = Math.max(0, Math.floor(spanStart * sampleRate));
	const endSample = Math.min(samples.length, Math.ceil(spanEnd * sampleRate));

	const intervals: EnergyInterval[] = [];
	let runStart: number | null = null;

	for (let base = startSample; base < endSample; base += frameLen) {
		const frameEnd = Math.min(base + frameLen, endSample);
		let sumSquares = 0;
		for (let i = base; i < frameEnd; i++) {
			sumSquares += samples[i] * samples[i];
		}
		const rms = Math.sqrt(sumSquares / Math.max(1, frameEnd - base));
		const silent = rmsToDb(rms) < thresholdDb;
		const matches = want === "silent" ? silent : !silent;

		if (matches && runStart === null) {
			runStart = base;
		} else if (!matches && runStart !== null) {
			intervals.push({ start: runStart / sampleRate, end: base / sampleRate });
			runStart = null;
		}
	}

	if (runStart !== null) {
		intervals.push({
			start: runStart / sampleRate,
			end: endSample / sampleRate,
		});
	}

	return intervals;
}
