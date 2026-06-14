import type { MinimaxTool } from "./client";

export const SKILL_SYSTEM_PROMPT = `You are the editing assistant for OpenCut, a video editor.
Translate the user's request into exactly ONE tool call — never answer with plain text.
Times and durations are in seconds (floating point).
The current editor state (with the REAL elementId and trackId of every clip/text/audio) is given in the user message. Always use those exact IDs when targeting an element.
"el inicio" / "the beginning" means startTime 0.
Volume is 0.0 (silent) to 2.0 (double), default 1.0.
Distinguish: "separar/extraer/detach audio" => separate_audio (moves the clip's audio to its own track). "quitar/silenciar/mute audio" => change_volume with volume 0. "subir/bajar volumen" => change_volume.
TikTok-style editing: "ponlo vertical / formato tiktok / 9:16" => set_aspect_ratio. "pon música de fondo / usa el audio X de fondo" => add_background_music (match the asset by name from the provided assets list, pass its mediaId). "añade el video / clip X" => add_clip. "cámara lenta / acelera / x2 / slow motion" => change_speed (rate < 1 is slower, > 1 is faster).
The "assets" list in the state shows imported media (audio/video) with mediaId and name — use those mediaIds when the user references a clip or song by name.
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
			name: "set_aspect_ratio",
			description:
				"Set the canvas/video format. Use for 'ponlo vertical', 'formato tiktok', '9:16', 'cuadrado', '16:9'.",
			parameters: {
				type: "object",
				properties: {
					ratio: {
						type: "string",
						enum: ["9:16", "1:1", "4:5", "16:9"],
						description: "9:16 = TikTok/vertical, 1:1 = square, 16:9 = horizontal",
					},
				},
				required: ["ratio"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "add_background_music",
			description:
				"Add background music. Prefer an imported audio asset: pass its mediaId (from the assets list). Or pass a URL for external audio.",
			parameters: {
				type: "object",
				properties: {
					mediaId: { type: "string", description: "mediaId of an imported audio asset" },
					url: { type: "string", description: "Audio URL (alternative to mediaId)" },
					timelineStart: { type: "number" },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "add_clip",
			description:
				"Add an imported video/image asset to the timeline. Pass the mediaId from the assets list.",
			parameters: {
				type: "object",
				properties: {
					mediaId: { type: "string", description: "mediaId of an imported asset" },
					timelineStart: { type: "number" },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "change_speed",
			description:
				"Change playback speed of a clip (slow motion or speed up). rate < 1 slower, > 1 faster.",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					speed: { type: "number", description: "e.g. 0.5 = half speed, 2 = double" },
				},
				required: ["elementId", "speed"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "separate_audio",
			description:
				"Separate/detach a video clip's audio into its own audio track. Use this for requests like 'separa el audio del video', 'extrae el audio', 'split audio from video'. Pass the elementId of the VIDEO element.",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string", description: "elementId of the video clip" },
				},
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
