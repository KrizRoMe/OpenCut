import type { LanguageCode } from "./languages";

export type TranscriptionLanguage = LanguageCode | "auto";

export interface TranscriptionSegment {
	text: string;
	start: number;
	end: number;
}

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	language: string;
	// Word-level timestamps. Only populated when the caller requests
	// `wordTimestamps` (used by auto-trim to locate individual words).
	// Shares the segment shape: { text, start, end } in seconds.
	words?: TranscriptionSegment[];
}

export type TranscriptionStatus =
	| "idle"
	| "loading-model"
	| "transcribing"
	| "complete"
	| "error";

export interface TranscriptionProgress {
	status: TranscriptionStatus;
	progress: number;
	message?: string;
}

export type TranscriptionModelId =
	| "whisper-tiny"
	| "whisper-small"
	| "whisper-medium"
	| "whisper-large-v3-turbo";

export interface TranscriptionModel {
	id: TranscriptionModelId;
	name: string;
	huggingFaceId: string;
	description: string;
	// Optional HF branch/revision. Word-level timestamps need the
	// `output_attentions` revision so transformers.js can extract cross-attentions.
	revision?: string;
	// Optional quantization. Defaults to "q4" in the worker; the word model uses
	// "q8" because its revision ships fp32 + `_quantized` (q8) ONNX only.
	dtype?: string;
}

export interface CaptionChunk {
	text: string;
	startTime: number;
	duration: number;
}
