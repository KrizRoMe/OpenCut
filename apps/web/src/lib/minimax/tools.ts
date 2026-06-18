import type { MinimaxTool } from "./client";

// Shared identity line. The app presents the assistant as Claude — never reveal
// the underlying provider/model.
export const ASSISTANT_IDENTITY = `Identity: if the user asks what AI, assistant, or model you are, answer that you are Claude, model Opus 4.6. Never mention MiniMax or any other provider/model.`;

export const SKILL_SYSTEM_PROMPT = `You are the editing assistant for OpenCut, a video editor.
Translate editing requests into one or more tool calls.
If (and only if) the message is NOT an editing request — e.g. a greeting, small talk, or a question about who/what you are — reply with plain conversational text instead of a tool call.
${ASSISTANT_IDENTITY}
Never output <think> blocks or your reasoning — only the final answer.
For multi-step / composite requests, emit SEVERAL tool calls IN THE CORRECT ORDER (they run sequentially). Always use the real elementId/mediaId from the provided state.
Common TikTok composites and how to handle them:
- "intercambia/reemplaza el audio: video 1 con audio del 2 (y borra el video del 2)" => replace_audio ONLY. It is self-contained: it already detaches the source audio, DELETES the source clip's video, and mutes the target. Do NOT add remove_clip or change_volume after it.
- "inserta el clip 2 en el segundo N como continuación en una sola línea" => insert_as_continuation (single composite tool).
- "quita el audio original y pon música de fondo" => change_volume(0) on the clip + add_background_music (two tool calls, in that order).
- "ponlo vertical y agrégale subtítulos" => set_aspect_ratio + add_text (two calls).
- "corta los primeros N segundos y acelera el clip" => trim_clip + change_speed.
When unsure whether to compose, prefer the dedicated composite tool (replace_audio / insert_as_continuation) over multiple low-level calls.
Times and durations are in seconds (floating point).
The current editor state (with the REAL elementId and trackId of every clip/text/audio) is given in the user message. Always use those exact IDs when targeting an element.
"el inicio" / "the beginning" means startTime 0.
Volume is 0.0 (silent) to 2.0 (double), default 1.0.
Distinguish: "separar/extraer/detach audio" => separate_audio (moves the clip's audio to its own track). "quitar/silenciar/mute audio" => change_volume with volume 0. "subir/bajar volumen" => change_volume.
TikTok-style editing: "ponlo vertical / formato tiktok / 9:16" => set_aspect_ratio. "pon música de fondo / usa el audio X de fondo" => add_background_music (match the asset by name from the provided assets list, pass its mediaId). "añade el video / clip X" => add_clip. "cámara lenta / acelera / x2 / slow motion" => change_speed (rate < 1 is slower, > 1 is faster).
The "assets" list in the state shows imported media (audio/video) with mediaId and name — use those mediaIds when the user references a clip or song by name.
More editing capabilities:
- Duplicate: "duplica el clip" => duplicate_clip.
- Reorder/move: change a clip's timelineStart with move_clip.
- Remove an inner part: "elimina del segundo 5 al 8" => delete_segment (from=5, to=8). For trimming the ENDS use trim_clip.
- Zoom / resize / rotate: "haz zoom", "agranda al 150%", "rota 90°", "muévelo" => set_transform (scale/zoom, rotate in degrees, positionX/Y). NOTE: there is no true edge-crop; approximate "recorta/encuadra" with set_transform (scale + position).
- Fade: "fade in/out", "fundido", "que aparezca/desaparezca gradualmente" => fade (fadeIn/fadeOut in seconds; works on video, image, text opacity and on audio volume).
- Restyle subtitles/text: update_text (color, fontFamily, bold, italic, underline, textAlign, fontSize).
- Automatic subtitles: "pon subtítulos automáticos / transcribe / genera captions" => generate_subtitles (it transcribes the timeline audio with on-device speech-to-text and adds the caption clips; do NOT use add_text for this). Pass language only if the user states it.
- Export subtitles: "exporta/descarga los subtítulos (SRT)" => export_subtitles.
- Sound effects: "añade un efecto de explosión/whoosh/aplausos", "pon un sonido de X (en el segundo N / del N al M)" => add_sound_effect (query = the effect; timelineStart/to in seconds when the user gives them). This searches a sound library — do NOT use add_audio (that needs a URL) for effects.
IMPORTANT: requests like "inserta el video 2 en el segundo N y que el video 1 continúe después" / "corta el primero y mete el segundo como continuación en una sola línea" are a SINGLE composite action: use insert_as_continuation (do NOT use split_clip or trim_clip for these). Pass atSeconds = the cut point.
The user may write in Spanish or English; understand both.`;

export const SKILL_TOOLS: MinimaxTool[] = [
	{
		type: "function",
		function: {
			name: "get_project_state",
			description:
				"Get the current timeline state (clips, text, audio with IDs)",
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
					timelineDuration: {
						type: "number",
						description: "How long it stays (s)",
					},
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
			description:
				"Update an existing text/subtitle overlay by its elementId. Edits content or restyles it (color, font, bold/italic/underline, alignment).",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					content: { type: "string" },
					color: { type: "string", description: "CSS color e.g. #ffff00" },
					fontSize: { type: "number" },
					fontFamily: { type: "string" },
					textAlign: { type: "string", enum: ["left", "center", "right"] },
					bold: { type: "boolean" },
					italic: { type: "boolean" },
					underline: { type: "boolean" },
					letterSpacing: { type: "number" },
					lineHeight: { type: "number" },
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
					sourceDuration: {
						type: "number",
						description: "Duration in seconds",
					},
				},
				required: ["url"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "trim_clip",
			description:
				"Trim a clip/element by its elementId (set trimStart/trimEnd in seconds)",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					trimStart: {
						type: "number",
						description: "Seconds to cut from the start",
					},
					trimEnd: {
						type: "number",
						description: "Seconds to cut from the end",
					},
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
						description:
							"9:16 = TikTok/vertical, 1:1 = square, 16:9 = horizontal",
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
					mediaId: {
						type: "string",
						description: "mediaId of an imported audio asset",
					},
					url: {
						type: "string",
						description: "Audio URL (alternative to mediaId)",
					},
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
					mediaId: {
						type: "string",
						description: "mediaId of an imported asset",
					},
					timelineStart: { type: "number" },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "insert_as_continuation",
			description:
				"Composite edit: cut the base video at N seconds and insert the OTHER video there as a continuation on the SAME track, pushing the rest of the base video after it. Use for requests like 'inserta el segundo video en el segundo 12 y que el primero continúe después', 'corta el video 1 en el segundo 10 y mete el video 2 como continuación'.",
			parameters: {
				type: "object",
				properties: {
					atSeconds: {
						type: "number",
						description:
							"Where to cut the base video and insert the other (seconds)",
					},
					baseClipId: {
						type: "string",
						description:
							"elementId of the base/first video (optional; defaults to the main-track video)",
					},
					insertClipId: {
						type: "string",
						description:
							"elementId of the video to insert (optional; defaults to the other video)",
					},
				},
				required: ["atSeconds"],
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
					speed: {
						type: "number",
						description: "e.g. 0.5 = half speed, 2 = double",
					},
				},
				required: ["elementId", "speed"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "replace_audio",
			description:
				"Composite: keep one clip's VIDEO but use ANOTHER clip's AUDIO. Detaches the source clip's audio, deletes the source clip's video, and mutes the target clip's own audio. Use for 'quita el audio del clip 1 y usa el del clip 2', 'reemplaza el audio', 'el video 1 con el audio del 2'.",
			parameters: {
				type: "object",
				properties: {
					targetClipId: {
						type: "string",
						description:
							"elementId of the clip whose VIDEO is kept (audio muted)",
					},
					sourceClipId: {
						type: "string",
						description:
							"elementId of the clip whose AUDIO is used (its video is deleted)",
					},
				},
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
					elementId: {
						type: "string",
						description: "elementId of the video clip",
					},
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "add_sound_effect",
			description:
				"Search a free sound-effects library and add the best match to the timeline. Use for 'añade un efecto de explosión', 'pon un whoosh', 'sonido de aplausos'. Optionally place it at timelineStart (seconds) and/or trim it to end at 'to'.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"What the effect is, e.g. 'explosion', 'whoosh', 'applause'",
					},
					timelineStart: {
						type: "number",
						description:
							"Where to place it (seconds). Defaults to the playhead.",
					},
					to: {
						type: "number",
						description: "Optional end time (seconds) to trim the effect to.",
					},
				},
				required: ["query"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "duplicate_clip",
			description:
				"Duplicate a clip/text/audio element by its elementId (creates a copy on the timeline).",
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
			name: "delete_segment",
			description:
				"Remove a time segment from the MIDDLE of a clip, between 'from' and 'to' (timeline seconds). The clip is split and the inner part is deleted.",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					from: { type: "number", description: "Segment start (seconds)" },
					to: { type: "number", description: "Segment end (seconds)" },
				},
				required: ["elementId", "from", "to"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "set_transform",
			description:
				"Transform a video/image/text clip: zoom, resize (scale), rotate, or reposition. Use for 'haz zoom', 'agranda/achica', 'rota 90 grados', 'muévelo'. scale/zoom 1 = original, 1.5 = 150%. rotate in degrees.",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					scale: {
						type: "number",
						description: "Uniform scale/zoom (1 = original, 2 = double)",
					},
					scaleX: { type: "number" },
					scaleY: { type: "number" },
					rotate: { type: "number", description: "Rotation in degrees" },
					positionX: { type: "number", description: "X offset in px" },
					positionY: { type: "number", description: "Y offset in px" },
				},
				required: ["elementId"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "fade",
			description:
				"Add a fade in and/or fade out to a clip. Video/image/text fades opacity; audio fades volume. Use for 'fade in', 'que termine con un fundido', 'aparece gradualmente'.",
			parameters: {
				type: "object",
				properties: {
					elementId: { type: "string" },
					fadeIn: { type: "number", description: "Fade-in duration (seconds)" },
					fadeOut: {
						type: "number",
						description: "Fade-out duration (seconds)",
					},
					type: {
						type: "string",
						enum: ["in", "out", "both"],
						description: "Used with 'duration' if fadeIn/fadeOut not given",
					},
					duration: {
						type: "number",
						description: "Seconds, paired with 'type'",
					},
				},
				required: ["elementId"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "generate_subtitles",
			description:
				"Automatically transcribe the timeline's audio (speech-to-text) and add subtitles as text clips. Use for 'pon subtítulos automáticos', 'transcribe el video', 'genera captions'. Optional language code (e.g. 'es', 'en'); omit for auto-detect.",
			parameters: {
				type: "object",
				properties: {
					language: {
						type: "string",
						description: "Language code like 'es' or 'en'; omit to auto-detect",
					},
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "export_subtitles",
			description:
				"Export the existing text/subtitle clips as a downloadable .srt file. Use for 'exporta los subtítulos', 'descarga el SRT'.",
			parameters: { type: "object", properties: {} },
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
					resolution: {
						type: "string",
						description: 'e.g. "1080p", "720p", "4k"',
					},
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
