import type { MinimaxTool } from "./client";

export const SKILL_SYSTEM_PROMPT = `You are the editing assistant for OpenCut, a video editor.
Translate the user's request into exactly ONE tool call — never answer with plain text.
Times and durations are in seconds (floating point).
The current editor state (with the REAL elementId and trackId of every clip/text/audio) is given in the user message. Always use those exact IDs when targeting an element.
"el inicio" / "the beginning" means startTime 0.
Volume is 0.0 (silent) to 2.0 (double), default 1.0.
The user may write in Spanish or English; understand both.`;

export const SKILL_TOOLS: MinimaxTool[] = [
	{
		type: "function",
		function: {
			name: "get_project_state",
			description: "Get the current timeline state (clips, text, audio with IDs)",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			name: "add_text",
			description: "Add a text overlay to the timeline",
			parameters: {
				type: "object",
				properties: {
					content: { type: "string", description: "Text to display" },
					timelineStart: { type: "number", description: "When it appears (s)" },
					timelineDuration: { type: "number", description: "How long it stays (s)" },
					fontSize: { type: "number" },
					color: { type: "string", description: "CSS color e.g. #ffffff" },
					align: { type: "string", enum: ["left", "center", "right"] },
				},
				required: ["content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "update_text",
			description: "Update an existing text overlay by its elementId",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					content: { type: "string" },
					color: { type: "string" },
					fontSize: { type: "number" },
				},
				required: ["elementId"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "add_audio",
			description: "Add background music / audio from a URL",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "Audio file URL" },
					name: { type: "string" },
					timelineStart: { type: "number" },
					sourceDuration: { type: "number", description: "Duration in seconds" },
				},
				required: ["url"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "trim_clip",
			description: "Trim a clip/element by its elementId (set trimStart/trimEnd in seconds)",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					trimStart: { type: "number", description: "Seconds to cut from the start" },
					trimEnd: { type: "number", description: "Seconds to cut from the end" },
				},
				required: ["elementId"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "split_clip",
			description: "Split a clip/element at a timeline position (seconds)",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					splitAt: { type: "number" },
				},
				required: ["elementId", "splitAt"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "move_clip",
			description: "Move a clip/element to a new timeline position (seconds)",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					timelineStart: { type: "number" },
				},
				required: ["elementId", "timelineStart"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "remove_clip",
			description: "Remove a clip/text/audio element by its elementId",
			parameters: {
				type: "object",
				properties: { elementId: { type: "string" } },
				required: ["elementId"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "change_volume",
			description: "Change the volume of a clip/audio element (0.0-2.0)",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					volume: { type: "number" },
				},
				required: ["elementId", "volume"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "export_video",
			description: "Export/render the video",
			parameters: {
				type: "object",
				properties: {
					format: { type: "string", enum: ["mp4", "webm"] },
					resolution: { type: "string", description: 'e.g. "1080p", "720p", "4k"' },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "undo",
			description: "Undo the last action",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			name: "redo",
			description: "Redo the last undone action",
			parameters: { type: "object", properties: {} },
		},
	},
];
