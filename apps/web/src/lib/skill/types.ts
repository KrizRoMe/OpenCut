// High-level, UI-decoupled action contracts for the Video Editor Skill.
// These map natural-language intent (translated by the LLM) to operations on
// the client-side EditorCore. Designed to be MCP/tool-call friendly.

export type SkillActionName =
	| "get_project_state"
	| "create_project"
	| "open_project"
	| "list_projects"
	| "add_text"
	| "update_text"
	| "add_audio"
	| "trim_clip"
	| "split_clip"
	| "move_clip"
	| "remove_clip"
	| "change_volume"
	| "separate_audio"
	| "replace_audio"
	| "change_speed"
	| "add_clip"
	| "insert_as_continuation"
	| "add_background_music"
	| "set_aspect_ratio"
	| "zoom_timeline"
	| "export_video"
	| "undo"
	| "redo";

export interface SkillAction {
	action: SkillActionName;
	payload: Record<string, unknown>;
}

export interface ElementSummary {
	elementId: string;
	trackId: string;
	trackType: string;
	type: string;
	name: string;
	content?: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume?: number;
}

export interface AssetSummary {
	mediaId: string;
	name: string;
	type: string; // "video" | "audio" | "image"
	duration: number;
	hasAudio: boolean;
}

export interface EditorSnapshot {
	hasProject: boolean;
	projectId: string | null;
	projectName: string | null;
	canvasSize: { width: number; height: number } | null;
	totalDuration: number;
	canUndo: boolean;
	canRedo: boolean;
	elements: ElementSummary[];
	assets: AssetSummary[];
}

export type SkillResult =
	| { success: true; message: string; snapshot: EditorSnapshot; extra?: Record<string, unknown> }
	| { success: false; error: string };
