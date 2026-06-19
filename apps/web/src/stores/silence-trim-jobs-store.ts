import { create } from "zustand";
import { toast } from "sonner";
import { EditorCore } from "@/core";
import { extractTranscriptionSamples } from "@/lib/media/audio";
import { transcriptionService } from "@/services/transcription/service";
import { TICKS_PER_SECOND } from "@/lib/wasm/ticks";
import type {
	TranscriptionLanguage,
	TranscriptionProgress,
} from "@/lib/transcription/types";
import {
	type AutoTrimConfig,
	type CutRange,
	type TranscriptWord,
	detectDisfluencyCuts,
	detectSilenceCuts,
	planAutoTrim,
	resolveAutoTrimConfig,
	wordsFromSegments,
} from "@/lib/silence";
import { applyAutoTrimCuts } from "@/lib/silence/apply-cuts";

// Reuses the single-toast pattern from the transcription jobs store.
const TOAST_ID = "auto-trim-job";

export type AutoTrimJobStatus =
	| "extracting"
	| "loading-model"
	| "transcribing"
	| "analyzing"
	| "trimming"
	| "done"
	| "error"
	| "cancelled";

export interface AutoTrimJob {
	id: string;
	status: AutoTrimJobStatus;
	step: string;
	// 0-100 while loading the model; -1 when indeterminate.
	progress: number;
	error: string | null;
	// Filled when the job completes.
	cutCount: number;
	removedSeconds: number;
}

interface StartResult {
	started: boolean;
	reason?: string;
}

interface AutoTrimJobsState {
	job: AutoTrimJob | null;
	// Fire-and-forget, mirroring startTranscription: kicks the pipeline off
	// detached so the chat turn / editor stay responsive. Targets a single clip
	// (the selected one, or `elementId`); the whole clip's audio is analysed and
	// silences/disfluencies are trimmed in place with ripple.
	startAutoTrim: (args?: {
		elementId?: string;
		language?: TranscriptionLanguage;
		config?: Partial<AutoTrimConfig>;
	}) => StartResult;
	cancel: () => void;
}

function isJobActive(job: AutoTrimJob | null): boolean {
	return (
		job !== null &&
		job.status !== "done" &&
		job.status !== "error" &&
		job.status !== "cancelled"
	);
}

// Resolve the clip to trim: an explicit id, else the current selection, else the
// first element on the main track. Returns the timeline-second span too.
function resolveTarget({ elementId }: { elementId?: string }): {
	trackId: string;
	elementId: string;
	spanStart: number;
	spanEnd: number;
} | null {
	const editor = EditorCore.getInstance();
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) return null;

	const tracks = [
		scene.tracks.main,
		...scene.tracks.overlay,
		...scene.tracks.audio,
	];

	const selected = editor.selection.getSelectedElements();
	const wantedId = elementId ?? selected[0]?.elementId;

	for (const track of tracks) {
		for (const element of track.elements) {
			const matches = wantedId
				? element.id === wantedId
				: track.id === scene.tracks.main.id;
			if (!matches) continue;
			const spanStart = element.startTime / TICKS_PER_SECOND;
			const spanEnd = (element.startTime + element.duration) / TICKS_PER_SECOND;
			return { trackId: track.id, elementId: element.id, spanStart, spanEnd };
		}
	}

	return null;
}

function stepFromProgress(progress: TranscriptionProgress): {
	status: AutoTrimJobStatus;
	step: string;
	progress: number;
} {
	if (progress.status === "loading-model") {
		const pct = Math.round(progress.progress);
		return {
			status: "loading-model",
			step: `Cargando modelo de transcripción… ${pct}%`,
			progress: pct,
		};
	}
	return {
		status: "transcribing",
		step: "Analizando el audio (puede tardar)…",
		progress: -1,
	};
}

export const useSilenceTrimJobsStore = create<AutoTrimJobsState>((set, get) => {
	const setJob = (patch: Partial<AutoTrimJob>) =>
		set((state) => ({
			job: { ...(state.job as AutoTrimJob), ...patch },
		}));

	const runJob = async ({
		target,
		language,
		config,
	}: {
		target: NonNullable<ReturnType<typeof resolveTarget>>;
		language: TranscriptionLanguage;
		config: AutoTrimConfig;
	}) => {
		const editor = EditorCore.getInstance();
		const scene = editor.scenes.getActiveSceneOrNull();
		const jobId = Math.random().toString(36).slice(2);

		if (!scene) return;

		set({
			job: {
				id: jobId,
				status: "extracting",
				step: "Extrayendo audio del clip…",
				progress: -1,
				error: null,
				cutCount: 0,
				removedSeconds: 0,
			},
		});

		toast.loading("Extrayendo audio del clip…", {
			id: TOAST_ID,
			duration: Number.POSITIVE_INFINITY,
			action: { label: "Cancelar", onClick: () => get().cancel() },
		});

		try {
			const { samples, sampleRate } = await extractTranscriptionSamples({
				tracks: scene.tracks,
				mediaAssets: editor.media.getAssets(),
				totalDuration: editor.timeline.getTotalDuration(),
				filterElement: (element) => element.id === target.elementId,
			});

			if (!isJobActive(get().job)) return;

			// Transcription is needed to locate repeated words / phrase restarts.
			const needsTranscription =
				config.removeRepeatedWords || config.removePhraseRestarts;

			let words: TranscriptWord[] = [];
			if (needsTranscription) {
				try {
					// Use the SAME reliable segment-level transcription the captions flow
					// uses (default model), then derive per-word timings from it. True
					// word-level timestamps need a cross-attention model the app doesn't
					// have and that returned almost nothing in practice.
					const result = await transcriptionService.transcribe({
						audioData: samples,
						language: language === "auto" ? undefined : language,
						onProgress: (progress) => {
							if (!isJobActive(get().job)) return;
							const next = stepFromProgress(progress);
							setJob(next);
							toast.loading(next.step, {
								id: TOAST_ID,
								duration: Number.POSITIVE_INFINITY,
								action: { label: "Cancelar", onClick: () => get().cancel() },
							});
						},
					});
					words = wordsFromSegments(result.segments);
				} catch (error) {
					// A user cancel rejects this promise too — let it bubble to the
					// outer handler so it's treated as a clean dismissal.
					if (
						get().job?.status === "cancelled" ||
						/cancel/i.test(String(error))
					) {
						throw error;
					}
					// Otherwise degrade gracefully: word-based cuts are lost but silence
					// removal still works (it relies on amplitude, not transcription).
					if (!config.removeSilences) throw error;
					console.error(
						"Auto-trim transcription unavailable; trimming silences only:",
						error,
					);
					toast.message(
						"No se pudieron analizar las palabras; recortando solo silencios.",
						{ id: TOAST_ID, duration: 5000 },
					);
					words = [];
				}
			}

			if (!isJobActive(get().job)) return;

			setJob({
				status: "analyzing",
				step: "Detectando silencios y repeticiones…",
			});

			const silenceCuts = detectSilenceCuts({
				samples,
				sampleRate,
				spanStart: target.spanStart,
				spanEnd: target.spanEnd,
				config,
			});
			const disfluencyCuts = detectDisfluencyCuts({ words, config });
			const rawCuts: CutRange[] = [...silenceCuts, ...disfluencyCuts];

			const plan = planAutoTrim({
				cuts: rawCuts,
				spanStart: target.spanStart,
				spanEnd: target.spanEnd,
				config,
			});

			// Diagnostics: lets us tell apart "no words transcribed" from "words but
			// nothing matched the rules" when tuning.
			console.info(
				`[auto-trim] words=${words.length} silenceCuts=${silenceCuts.length} disfluencyCuts=${disfluencyCuts.length} planned=${plan.cuts.length}`,
			);
			console.info(
				"[auto-trim] transcript:",
				words
					.map((word) => word.text)
					.join(" ")
					.slice(0, 300),
			);

			if (plan.cuts.length === 0) {
				setJob({
					status: "done",
					step: "Nada que recortar",
					cutCount: 0,
					removedSeconds: 0,
				});
				toast.success(
					"No encontré silencios ni repeticiones que recortar con la configuración actual.",
					{
						id: TOAST_ID,
						duration: 6000,
					},
				);
				return;
			}

			if (!isJobActive(get().job)) return;

			setJob({ status: "trimming", step: "Recortando el clip…" });
			const applied = applyAutoTrimCuts({
				editor,
				trackId: target.trackId,
				elementId: target.elementId,
				cuts: plan.cuts,
			});

			const removed = plan.removedSeconds.toFixed(1);
			setJob({
				status: "done",
				step: `Recorte listo (${applied} cortes, ${removed}s)`,
				cutCount: applied,
				removedSeconds: plan.removedSeconds,
			});
			toast.success(
				`Auto-trim listo: ${applied} cortes, ${removed}s eliminados.`,
				{
					id: TOAST_ID,
					duration: 5000,
				},
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Error en el auto-trim.";
			if (get().job?.status === "cancelled" || /cancel/i.test(message)) {
				set({
					job: {
						id: jobId,
						status: "cancelled",
						step: "Auto-trim cancelado",
						progress: -1,
						error: null,
						cutCount: 0,
						removedSeconds: 0,
					},
				});
				toast.dismiss(TOAST_ID);
				return;
			}
			console.error("Auto-trim failed:", error);
			setJob({ status: "error", step: "Error", error: message });
			toast.error(message, { id: TOAST_ID, duration: 6000 });
		}
	};

	return {
		job: null,

		startAutoTrim: ({ elementId, language = "auto", config } = {}) => {
			const editor = EditorCore.getInstance();
			const scene = editor.scenes.getActiveSceneOrNull();
			if (!scene) {
				return { started: false, reason: "No hay proyecto abierto." };
			}
			if (editor.timeline.getTotalDuration() <= 0) {
				return { started: false, reason: "La línea de tiempo está vacía." };
			}
			if (isJobActive(get().job)) {
				return { started: false, reason: "Ya hay un auto-trim en curso." };
			}
			const target = resolveTarget({ elementId });
			if (!target) {
				return { started: false, reason: "No se encontró el clip a recortar." };
			}

			void runJob({
				target,
				language,
				config: resolveAutoTrimConfig(config),
			});
			return { started: true };
		},

		cancel: () => {
			if (!isJobActive(get().job)) return;
			transcriptionService.cancel();
			set((state) => ({
				job: state.job
					? { ...state.job, status: "cancelled", step: "Cancelando…" }
					: null,
			}));
			toast.dismiss(TOAST_ID);
		},
	};
});
