import { create } from "zustand";
import { toast } from "sonner";
import { EditorCore } from "@/core";
import { extractTranscriptionSamples } from "@/lib/media/audio";
import { transcriptionService } from "@/services/transcription/service";
import { buildCaptionChunks } from "@/lib/transcription/caption";
import { insertCaptionChunksAsTextTrack } from "@/lib/subtitles/insert";
import type {
	TranscriptionLanguage,
	TranscriptionProgress,
} from "@/lib/transcription/types";

// A single, stable toast id so progress updates replace the same toast instead
// of stacking new ones.
const TOAST_ID = "transcription-job";

export type TranscriptionJobStatus =
	| "extracting"
	| "loading-model"
	| "transcribing"
	| "inserting"
	| "done"
	| "error"
	| "cancelled";

export interface TranscriptionJob {
	// Unique per run so subscribers (e.g. the AI chat) can notify exactly once
	// when a job reaches a terminal state.
	id: string;
	status: TranscriptionJobStatus;
	// Human-readable description of the current step (shown in the toast/panel).
	step: string;
	// 0-100 while loading the model; -1 when indeterminate (e.g. transcribing).
	progress: number;
	language: TranscriptionLanguage;
	error: string | null;
	// Number of caption lines produced (set when the job completes).
	lineCount: number;
}

interface StartResult {
	started: boolean;
	reason?: string;
}

// A single queued/running transcription request. Captured so the worker (a
// singleton) can process requests one at a time — e.g. "subtitle the video in
// Spanish" then "subtitle the audio in English" enqueue two of these.
interface TranscriptionRequest {
	language: TranscriptionLanguage;
	// When set, only this timeline element's audio is transcribed (per-source
	// subtitles). Omit to transcribe the whole mixed timeline.
	filterElementId?: string;
	// Source tag woven into the resulting caption names (e.g. "video", "audio")
	// so each source's captions can later be targeted/removed independently.
	sourceLabel?: string;
}

interface TranscriptionJobsState {
	// Only one job runs at a time: the transcription worker is a singleton.
	job: TranscriptionJob | null;
	// Requests waiting to run after the active one finishes (FIFO).
	queue: TranscriptionRequest[];
	// Kicks off the pipeline detached and returns immediately. The heavy work
	// (audio extraction + on-device Whisper) runs in the background so the chat
	// turn / editor stay responsive. When a job is already running the request
	// is queued and processed when the current one completes.
	startTranscription: (args?: {
		language?: TranscriptionLanguage;
		filterElementId?: string;
		sourceLabel?: string;
	}) => StartResult;
	cancel: () => void;
}

function isJobActive(job: TranscriptionJob | null): boolean {
	return (
		job !== null &&
		job.status !== "done" &&
		job.status !== "error" &&
		job.status !== "cancelled"
	);
}

function stepFromProgress(progress: TranscriptionProgress): {
	status: TranscriptionJobStatus;
	step: string;
	progress: number;
} {
	if (progress.status === "loading-model") {
		const pct = Math.round(progress.progress);
		return {
			status: "loading-model",
			// The model is fetched once and then cached; show the load/download %.
			step: `Cargando modelo de transcripción… ${pct}%`,
			progress: pct,
		};
	}
	return {
		status: "transcribing",
		step: "Transcribiendo audio (puede tardar)…",
		progress: -1,
	};
}

export const useTranscriptionJobsStore = create<TranscriptionJobsState>(
	(set, get) => {
		const setJob = (patch: Partial<TranscriptionJob>) =>
			set((state) => ({
				job: { ...(state.job as TranscriptionJob), ...patch },
			}));

		// Run one request to completion. Always drains the queue afterwards so
		// chained requests (e.g. video→ES, audio→EN) run back-to-back.
		const runJob = async (request: TranscriptionRequest) => {
			const { language, filterElementId, sourceLabel } = request;
			const editor = EditorCore.getInstance();
			const scene = editor.scenes.getActiveSceneOrNull();
			const jobId = Math.random().toString(36).slice(2);

			if (!scene || editor.timeline.getTotalDuration() <= 0) {
				processQueue();
				return;
			}

			set({
				job: {
					id: jobId,
					status: "extracting",
					step: "Extrayendo audio del timeline…",
					progress: -1,
					language,
					error: null,
					lineCount: 0,
				},
			});

			toast.loading("Extrayendo audio del timeline…", {
				id: TOAST_ID,
				duration: Number.POSITIVE_INFINITY,
				action: { label: "Cancelar", onClick: () => get().cancel() },
			});

			try {
				// Snapshot the timeline audio at start; later edits won't affect it.
				// Renders straight to mono @16kHz with decode/resample/downmix all
				// off the main thread — no WAV encode/decode round-trip — so the
				// editor stays navigable while this runs. When filterElementId is set
				// only that element's audio is transcribed (per-source subtitles).
				const { samples } = await extractTranscriptionSamples({
					tracks: scene.tracks,
					mediaAssets: editor.media.getAssets(),
					totalDuration: editor.timeline.getTotalDuration(),
					filterElement: filterElementId
						? (element) => element.id === filterElementId
						: undefined,
				});

				if (!isJobActive(get().job)) return;

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

				if (!isJobActive(get().job)) return;

				setJob({ status: "inserting", step: "Insertando subtítulos…" });
				const chunks = buildCaptionChunks({ segments: result.segments });
				const createdTrackId = insertCaptionChunksAsTextTrack({
					editor,
					captions: chunks,
					sourceLabel,
				});

				if (!createdTrackId || chunks.length === 0) {
					setJob({
						status: "error",
						step: "Sin subtítulos",
						error: "No se generaron subtítulos (¿el audio tiene voz?).",
					});
					toast.error("No se generaron subtítulos (¿el audio tiene voz?).", {
						id: TOAST_ID,
						duration: 6000,
					});
					return;
				}

				setJob({
					status: "done",
					step: `Subtítulos listos (${chunks.length} líneas)`,
					lineCount: chunks.length,
				});
				toast.success(`Subtítulos listos (${chunks.length} líneas).`, {
					id: TOAST_ID,
					duration: 5000,
				});
			} catch (error) {
				// A user-triggered cancel rejects the transcribe promise; treat it as
				// a clean dismissal rather than an error.
				const message =
					error instanceof Error ? error.message : "Error de transcripción.";
				if (get().job?.status === "cancelled" || /cancel/i.test(message)) {
					set({
						job: {
							id: jobId,
							status: "cancelled",
							step: "Transcripción cancelada",
							progress: -1,
							language,
							error: null,
							lineCount: 0,
						},
					});
					toast.dismiss(TOAST_ID);
					return;
				}
				console.error("Background transcription failed:", error);
				setJob({ status: "error", step: "Error", error: message });
				toast.error(message, { id: TOAST_ID, duration: 6000 });
			} finally {
				// Hand off to the next queued request (no-op if the queue is empty or a
				// job is somehow still active).
				processQueue();
			}
		};

		// Start the next queued request if nothing is currently running.
		const processQueue = () => {
			if (isJobActive(get().job)) return;
			const [next, ...rest] = get().queue;
			if (!next) return;
			set({ queue: rest });
			void runJob(next);
		};

		return {
			job: null,
			queue: [],

			startTranscription: ({
				language = "auto",
				filterElementId,
				sourceLabel,
			} = {}) => {
				const editor = EditorCore.getInstance();
				const scene = editor.scenes.getActiveSceneOrNull();
				if (!scene) {
					return { started: false, reason: "No hay proyecto abierto." };
				}
				if (editor.timeline.getTotalDuration() <= 0) {
					return { started: false, reason: "La línea de tiempo está vacía." };
				}

				set((state) => ({
					queue: [...state.queue, { language, filterElementId, sourceLabel }],
				}));
				processQueue();
				return { started: true };
			},

			cancel: () => {
				// Drop anything queued so a cancel doesn't silently start the next job.
				set({ queue: [] });
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
	},
);
