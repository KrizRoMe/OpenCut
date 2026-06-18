// Client-side skill executor: maps high-level semantic actions to operations on
// the EditorCore singleton. This is the UI-decoupled "command layer" the AI chat
// (or any future MCP tool) calls. Runs in the browser because EditorCore and its
// IndexedDB-backed state live there.

import { EditorCore } from "@/core";
import {
	buildElementFromMedia,
	buildLibraryAudioElement,
	buildTextElement,
	isRetimableElement,
} from "@/lib/timeline/element-utils";
import {
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/lib/retime";
import type { TimelineElement } from "@/lib/timeline";
import type { Transform } from "@/lib/rendering";
import {
	type ExportQuality,
	downloadBuffer,
	getExportFileExtension,
	getExportMimeType,
} from "@/lib/export";
import { TICKS_PER_SECOND } from "@/lib/wasm/ticks";
import { FONT_SIZE_SCALE_REFERENCE } from "@/lib/text/typography";
import { extractTimelineAudio } from "@/lib/media/mediabunny";
import { decodeAudioToFloat32 } from "@/lib/media/audio";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/lib/transcription/audio";
import { transcriptionService } from "@/services/transcription/service";
import { buildCaptionChunks } from "@/lib/transcription/caption";
import { insertCaptionChunksAsTextTrack } from "@/lib/subtitles/insert";
import { getEditorSnapshot } from "./state";
import type { AssetSummary, SkillAction, SkillResult } from "./types";

// Format seconds as an SRT timestamp: HH:MM:SS,mmm
function toSrtTimestamp(seconds: number): string {
	const ms = Math.max(0, Math.round(seconds * 1000));
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	const s = Math.floor((ms % 60_000) / 1000);
	const millis = ms % 1000;
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

// Trigger a client-side file download from a string payload.
function downloadTextFile({
	filename,
	content,
	mime,
}: {
	filename: string;
	content: string;
	mime: string;
}): void {
	const blob = new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

// Total length of an element's underlying source in ticks. Mirrors the timeline
// resize logic so trim edits can recompute the clip's visible duration.
function getElementSourceDuration(element: TimelineElement): number {
	if (typeof element.sourceDuration === "number") {
		return element.sourceDuration;
	}
	const visibleSpan = isRetimableElement(element)
		? getSourceSpanAtClipTime({
				clipTime: element.duration,
				retime: element.retime,
			})
		: element.duration;
	return element.trimStart + visibleSpan + element.trimEnd;
}

// The LLM/skill speaks in seconds; EditorCore stores integer "ticks".
const toTicks = (seconds: number): number =>
	Math.round(seconds * TICKS_PER_SECOND);

// Text sizing. The renderer scales a clip's fontSize by canvasHeight /
// FONT_SIZE_SCALE_REFERENCE, but there is no auto-wrap — so on a narrow canvas
// (e.g. 9:16 vertical) long text overflows horizontally. Pick a fontSize that
// keeps the longest line within the canvas width.
const DEFAULT_TEXT_FONT_SIZE = 15; // mirrors DEFAULTS.text.element.fontSize
const MIN_TEXT_FONT_SIZE = 5;
const TEXT_SAFE_WIDTH_RATIO = 0.9; // use at most 90% of the canvas width
const AVG_GLYPH_WIDTH_RATIO = 0.55; // approx glyph advance / fontSize for proportional fonts

function fitTextFontSize({
	content,
	canvas,
}: {
	content: string;
	canvas: { width: number; height: number };
}): number {
	const longestLine = content
		.split("\n")
		.reduce((max, line) => Math.max(max, line.trim().length), 0);
	if (longestLine <= 0 || canvas.height <= 0) return DEFAULT_TEXT_FONT_SIZE;
	const heightScale = canvas.height / FONT_SIZE_SCALE_REFERENCE;
	const maxByWidth =
		(canvas.width * TEXT_SAFE_WIDTH_RATIO) /
		(longestLine * AVG_GLYPH_WIDTH_RATIO * heightScale);
	// Never upscale past the default — only shrink long text to fit.
	return Math.max(
		MIN_TEXT_FONT_SIZE,
		Math.min(DEFAULT_TEXT_FONT_SIZE, maxByWidth),
	);
}

function ok(message: string, extra?: Record<string, unknown>): SkillResult {
	return { success: true, message, snapshot: getEditorSnapshot(), extra };
}

function fail(error: string): SkillResult {
	return { success: false, error };
}

function num(value: unknown, fallback: number): number {
	const n = typeof value === "string" ? Number.parseFloat(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Resolve the trackId for an element if the model only provided the elementId.
function resolveTrack({ elementId }: { elementId: string }): string | null {
	const snapshot = getEditorSnapshot();
	return (
		snapshot.elements.find((e) => e.elementId === elementId)?.trackId ?? null
	);
}

// Resolve an imported media asset by id, by (fuzzy) name, or fall back to the
// first asset of the requested type. Lets the user say "usa el audio tal".
function resolveAsset({
	hint,
	type,
}: {
	hint?: string;
	type: "audio" | "video" | "image";
}): AssetSummary | null {
	const assets = getEditorSnapshot().assets.filter((a) => a.type === type);
	if (assets.length === 0) return null;
	if (!hint) return assets[0];
	const lower = hint.toLowerCase();
	return (
		assets.find((a) => a.mediaId === hint) ??
		assets.find((a) => a.name.toLowerCase().includes(lower)) ??
		assets[0]
	);
}

function mapAspect({ ratio }: { ratio?: string }): {
	width: number;
	height: number;
} {
	const r = (ratio ?? "9:16").toLowerCase();
	if (r.includes("16:9") || r.includes("horizontal") || r.includes("landscape"))
		return { width: 1920, height: 1080 };
	if (r.includes("1:1") || r.includes("square") || r.includes("cuadrado"))
		return { width: 1080, height: 1080 };
	if (r.includes("4:5")) return { width: 1080, height: 1350 };
	// Default: vertical 9:16 (TikTok / Reels / Shorts)
	return { width: 1080, height: 1920 };
}

function mapQuality({ resolution }: { resolution?: string }): ExportQuality {
	if (!resolution) return "high";
	const r = resolution.toLowerCase();
	if (r.includes("4k") || r.includes("2160")) return "very_high";
	if (r.includes("1080")) return "high";
	if (r.includes("720")) return "medium";
	if (r.includes("480") || r.includes("360")) return "low";
	return "high";
}

export async function executeSkillAction({
	action,
	payload,
}: SkillAction): Promise<SkillResult> {
	const editor = EditorCore.getInstance();

	try {
		switch (action) {
			case "get_project_state":
				return ok("Estado del proyecto consultado.");

			case "create_project": {
				const name = str(payload.name) ?? "Nuevo proyecto";
				const id = await editor.project.createNewProject({ name });
				return ok(`Proyecto "${name}" creado.`, { projectId: id });
			}

			case "open_project": {
				const id = str(payload.projectId ?? payload.id);
				if (!id) return fail("Falta projectId.");
				await editor.project.loadProject({ id });
				return ok("Proyecto abierto.", { projectId: id });
			}

			case "list_projects": {
				const projects = editor.project.getSavedProjects();
				return ok(`${projects.length} proyecto(s).`, {
					projects: projects.map((p) => ({ id: p.id, name: p.name })),
				});
			}

			case "add_text": {
				const content = str(payload.content) ?? "Texto";
				const startTime = num(payload.timelineStart ?? payload.startTime, 0);
				const duration = num(payload.timelineDuration ?? payload.duration, 5);
				// Respect an explicit fontSize; otherwise size it to the current canvas
				// aspect ratio so it doesn't overflow (esp. on 9:16 vertical).
				const canvas = editor.project.getActiveOrNull()?.settings.canvasSize;
				const fontSize =
					payload.fontSize != null
						? num(payload.fontSize, DEFAULT_TEXT_FONT_SIZE)
						: canvas
							? fitTextFontSize({ content, canvas })
							: undefined;
				const element = buildTextElement({
					raw: {
						content,
						duration: toTicks(duration),
						fontSize,
						color: str(payload.color),
						textAlign: str(payload.align) as never,
					},
					startTime: toTicks(startTime),
				});
				editor.timeline.insertElement({ element, placement: { mode: "auto" } });
				return ok(`Texto "${content}" añadido.`);
			}

			case "update_text": {
				const elementId = str(payload.textId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del texto.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el texto.");
				const patch: Record<string, unknown> = {};
				if (str(payload.content)) patch.content = str(payload.content);
				if (str(payload.color)) patch.color = str(payload.color);
				if (payload.fontSize != null)
					patch.fontSize = num(payload.fontSize, 48);
				// Full style controls ("cambiar estilo de subtítulos").
				if (str(payload.fontFamily)) patch.fontFamily = str(payload.fontFamily);
				if (str(payload.textAlign ?? payload.align))
					patch.textAlign = str(payload.textAlign ?? payload.align);
				if (str(payload.fontWeight) || payload.bold != null)
					patch.fontWeight =
						str(payload.fontWeight) ?? (payload.bold ? "bold" : "normal");
				if (str(payload.fontStyle) || payload.italic != null)
					patch.fontStyle =
						str(payload.fontStyle) ?? (payload.italic ? "italic" : "normal");
				if (str(payload.textDecoration) || payload.underline != null)
					patch.textDecoration =
						str(payload.textDecoration) ??
						(payload.underline ? "underline" : "none");
				if (payload.letterSpacing != null)
					patch.letterSpacing = num(payload.letterSpacing, 0);
				if (payload.lineHeight != null)
					patch.lineHeight = num(payload.lineHeight, 1);
				if (Object.keys(patch).length === 0)
					return fail("No se indicó ningún cambio para el texto.");
				editor.timeline.updateElements({
					updates: [{ trackId, elementId, patch: patch as never }],
				});
				return ok("Texto actualizado.");
			}

			case "add_audio": {
				const url = str(payload.url ?? payload.sourceUrl);
				if (!url) return fail("Falta la URL del audio.");
				const startTime = num(payload.timelineStart ?? payload.startTime, 0);
				const duration = num(payload.sourceDuration ?? payload.duration, 30);
				const element = buildLibraryAudioElement({
					sourceUrl: url,
					name: str(payload.name) ?? "Audio",
					duration: toTicks(duration),
					startTime: toTicks(startTime),
				});
				editor.timeline.insertElement({ element, placement: { mode: "auto" } });
				return ok("Audio añadido.");
			}

			case "trim_clip": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip.");
				const [match] = editor.timeline.getElementsWithTracks({
					elements: [{ trackId, elementId }],
				});
				if (!match) return fail("No se encontró el clip.");
				const element = match.element;

				// Keep the current trim on whichever side the model didn't specify, so
				// incremental requests ("ahora quita los últimos 5s") don't silently
				// reset the other side back to 0.
				const hasTrimStart =
					payload.trimStart != null || payload.sourceStart != null;
				const trimStart = hasTrimStart
					? toTicks(num(payload.trimStart ?? payload.sourceStart, 0))
					: element.trimStart;
				const trimEnd =
					payload.trimEnd != null
						? toTicks(num(payload.trimEnd, 0))
						: element.trimEnd;

				// The update pipeline does NOT derive duration from trim, so compute the
				// new visible duration ourselves — otherwise the clip keeps its old
				// length and the trim is invisible.
				const sourceDuration = getElementSourceDuration(element);
				const visibleSpan = Math.max(0, sourceDuration - trimStart - trimEnd);
				const duration =
					payload.timelineDuration != null
						? toTicks(num(payload.timelineDuration, 0))
						: Math.round(
								isRetimableElement(element)
									? getTimelineDurationForSourceSpan({
											sourceSpan: visibleSpan,
											retime: element.retime,
										})
									: visibleSpan,
							);

				editor.timeline.updateElementTrim({
					elementId,
					trimStart,
					trimEnd,
					startTime:
						payload.timelineStart != null
							? toTicks(num(payload.timelineStart, 0))
							: undefined,
					duration,
				});
				return ok("Clip recortado.");
			}

			case "split_clip": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip.");
				editor.timeline.splitElements({
					elements: [{ trackId, elementId }],
					splitTime: toTicks(num(payload.splitAt ?? payload.splitTime, 0)),
				});
				return ok("Clip dividido.");
			}

			case "move_clip": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip.");
				editor.timeline.moveElement({
					sourceTrackId: trackId,
					targetTrackId: str(payload.targetTrackId) ?? trackId,
					elementId,
					newStartTime: toTicks(
						num(payload.timelineStart ?? payload.newStartTime, 0),
					),
				});
				return ok("Clip movido.");
			}

			case "remove_clip": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip.");
				editor.timeline.deleteElements({ elements: [{ trackId, elementId }] });
				return ok("Clip eliminado.");
			}

			case "change_volume": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip.");
				const volume = Math.max(0, Math.min(2, num(payload.volume, 1)));
				// volume alone doesn't silence a video clip (gated by `muted`), so sync
				// the muted flag with a 0 volume to make "quita el audio" actually work.
				editor.timeline.updateElements({
					updates: [
						{
							trackId,
							elementId,
							patch: { volume, muted: volume === 0 } as never,
						},
					],
				});
				return ok(
					volume === 0 ? "Audio silenciado." : `Volumen ajustado a ${volume}.`,
				);
			}

			case "add_background_music": {
				// Use an imported audio asset (or a URL) as background music.
				const url = str(payload.url ?? payload.sourceUrl);
				const startTime = num(payload.timelineStart ?? payload.startTime, 0);
				if (url) {
					const element = buildLibraryAudioElement({
						sourceUrl: url,
						name: str(payload.name) ?? "Música de fondo",
						duration: toTicks(
							num(payload.sourceDuration ?? payload.duration, 30),
						),
						startTime: toTicks(startTime),
					});
					editor.timeline.insertElement({
						element,
						placement: { mode: "auto" },
					});
					return ok("Música de fondo añadida.");
				}
				const asset = resolveAsset({
					hint: str(payload.mediaId ?? payload.assetName ?? payload.name),
					type: "audio",
				});
				if (!asset)
					return fail(
						"No hay ningún audio importado. Importa un audio o pásame una URL.",
					);
				const element = buildElementFromMedia({
					mediaId: asset.mediaId,
					mediaType: "audio",
					name: asset.name,
					duration: toTicks(asset.duration || num(payload.duration, 30)),
					startTime: toTicks(startTime),
				});
				editor.timeline.insertElement({ element, placement: { mode: "auto" } });
				return ok(`"${asset.name}" añadido como música de fondo.`);
			}

			case "add_clip": {
				// Add an imported video/image asset to the timeline.
				const requested = str(
					payload.mediaId ?? payload.assetName ?? payload.name,
				);
				const asset =
					resolveAsset({ hint: requested, type: "video" }) ??
					resolveAsset({ hint: requested, type: "image" });
				if (!asset)
					return fail("No hay ningún video/imagen importado para añadir.");
				const element = buildElementFromMedia({
					mediaId: asset.mediaId,
					mediaType: asset.type as "video" | "image",
					name: asset.name,
					duration: toTicks(asset.duration || num(payload.duration, 5)),
					startTime: toTicks(
						num(payload.timelineStart ?? payload.startTime, 0),
					),
				});
				editor.timeline.insertElement({ element, placement: { mode: "auto" } });
				return ok(`"${asset.name}" añadido al timeline.`);
			}

			case "insert_as_continuation": {
				// Composite: split the base video at N seconds, push its tail right by
				// the inserted clip's length, and drop the second clip into the gap on
				// the SAME track (sequential continuation).
				const scene = editor.scenes.getActiveSceneOrNull();
				if (!scene) return fail("No hay escena activa.");

				// Collect video elements with their track (raw ticks).
				const videoTracks = [scene.tracks.main, ...scene.tracks.overlay].filter(
					(t) => t.type === "video",
				);
				const videoEls: Array<{
					trackId: string;
					el: { id: string; startTime: number; duration: number };
				}> = [];
				for (const t of videoTracks) {
					for (const el of t.elements) {
						videoEls.push({ trackId: t.id, el: el as never });
					}
				}
				if (videoEls.length < 2)
					return fail("Necesito dos clips de video (base e insertado).");

				const mainTrackId = scene.tracks.main.id;
				// Base = clip on the main track; insert = the other video clip.
				const baseId = str(payload.baseClipId);
				const insertId = str(payload.insertClipId);
				const base =
					(baseId && videoEls.find((v) => v.el.id === baseId)) ||
					videoEls.find((v) => v.trackId === mainTrackId) ||
					videoEls[0];
				const insert =
					(insertId && videoEls.find((v) => v.el.id === insertId)) ||
					videoEls.find((v) => v.el.id !== base.el.id);
				if (!insert) return fail("No encontré el segundo video a insertar.");

				const atTicks = toTicks(
					num(payload.atSeconds ?? payload.splitAt ?? payload.timelineStart, 0),
				);
				const insertDuration = insert.el.duration;

				// 1) Split the base clip at the cut point (on its own track).
				const rightParts = editor.timeline.splitElements({
					elements: [{ trackId: base.trackId, elementId: base.el.id }],
					splitTime: atTicks,
				});
				const right = rightParts[0];

				// 2) Push the base's tail to after the inserted clip.
				if (right) {
					editor.timeline.moveElement({
						sourceTrackId: right.trackId,
						targetTrackId: base.trackId,
						elementId: right.elementId,
						newStartTime: atTicks + insertDuration,
					});
				}

				// 3) Drop the second clip into the gap, on the base track.
				editor.timeline.moveElement({
					sourceTrackId: insert.trackId,
					targetTrackId: base.trackId,
					elementId: insert.el.id,
					newStartTime: atTicks,
				});

				// Report the resulting layout so the result is observable/debuggable.
				const sceneAfter = editor.scenes.getActiveSceneOrNull();
				const layout: string[] = [];
				if (sceneAfter) {
					const tracksAfter = [
						sceneAfter.tracks.main,
						...sceneAfter.tracks.overlay,
					].filter((t) => t.type === "video");
					for (const t of tracksAfter) {
						for (const el of t.elements) {
							const s = el.startTime / TICKS_PER_SECOND;
							const e = (el.startTime + el.duration) / TICKS_PER_SECOND;
							const onBase =
								t.id === base.trackId ? "✓" : `pista ${t.id.slice(0, 4)}`;
							layout.push(
								`${el.name.slice(0, 14)} [${s.toFixed(1)}–${e.toFixed(1)}s] ${onBase}`,
							);
						}
					}
				}
				return ok(
					`Insertado como continuación. Resultado: ${layout.join(" | ")}`,
					{ layout },
				);
			}

			case "change_speed": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip.");
				const rate = Math.max(
					0.25,
					Math.min(4, num(payload.speed ?? payload.rate, 1)),
				);
				editor.timeline.updateElementRetime({
					trackId,
					elementId,
					retime: { rate, maintainPitch: true },
				});
				return ok(`Velocidad cambiada a ${rate}x.`);
			}

			case "set_aspect_ratio": {
				const size = mapAspect({
					ratio: str(payload.ratio ?? payload.aspect ?? payload.format),
				});
				await editor.project.updateSettings({
					settings: { canvasSize: size, canvasSizeMode: "custom" },
				});
				return ok(`Formato cambiado a ${size.width}×${size.height}.`);
			}

			case "replace_audio": {
				// Composite: keep the target video but with the SOURCE clip's audio.
				// Steps: separate source audio -> delete source video -> mute target audio.
				const scene = editor.scenes.getActiveSceneOrNull();
				if (!scene) return fail("No hay escena activa.");
				const videoTracks = [scene.tracks.main, ...scene.tracks.overlay].filter(
					(t) => t.type === "video",
				);
				const videos: Array<{ trackId: string; id: string }> = [];
				for (const t of videoTracks)
					for (const el of t.elements)
						videos.push({ trackId: t.id, id: el.id });
				if (videos.length < 2)
					return fail(
						"Necesito dos clips de video (destino y fuente del audio).",
					);

				const targetId = str(payload.targetClipId ?? payload.keepVideoOf);
				const sourceId = str(payload.sourceClipId ?? payload.useAudioOf);
				const target =
					(targetId && videos.find((v) => v.id === targetId)) ||
					videos.find((v) => v.trackId === scene.tracks.main.id) ||
					videos[0];
				const source =
					(sourceId && videos.find((v) => v.id === sourceId)) ||
					videos.find((v) => v.id !== target.id);
				if (!source) return fail("No encontré el clip fuente del audio.");

				// Count audio elements before separation to confirm extraction worked.
				const countAudio = () => {
					const sc = editor.scenes.getActiveSceneOrNull();
					return sc
						? sc.tracks.audio.reduce((n, t) => n + t.elements.length, 0)
						: 0;
				};
				const audioBefore = countAudio();

				// 1) Detach the source clip's audio into its own track.
				editor.timeline.toggleSourceAudioSeparation({
					trackId: source.trackId,
					elementId: source.id,
				});

				if (countAudio() <= audioBefore) {
					return fail(
						"El clip fuente no tiene audio extraíble, así que no se pudo reemplazar el audio.",
					);
				}

				// 2) Remove the source clip's video (its separated audio stays).
				editor.timeline.deleteElements({
					elements: [{ trackId: source.trackId, elementId: source.id }],
				});
				// 3) Remove the target clip's OWN audio. For video elements the audio
				// is gated by isSourceAudioEnabled (not volume), so disable it + mute.
				editor.timeline.updateElements({
					updates: [
						{
							trackId: target.trackId,
							elementId: target.id,
							patch: { isSourceAudioEnabled: false, muted: true } as never,
						},
					],
				});
				return ok(
					"Listo. El clip destino conserva su VIDEO (su audio original quedó silenciado) y ahora suena el AUDIO del clip fuente (su video se eliminó). Ya no necesitas hacer nada más.",
				);
			}

			case "separate_audio": {
				// Detach a video clip's source audio into its own audio track.
				let elementId = str(payload.clipId ?? payload.elementId);
				// If the model didn't specify, target the first video element.
				if (!elementId) {
					const video = getEditorSnapshot().elements.find(
						(e) => e.type === "video",
					);
					elementId = video?.elementId;
				}
				if (!elementId)
					return fail("No hay ningún clip de video para separar el audio.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip de video.");
				editor.timeline.toggleSourceAudioSeparation({ trackId, elementId });
				return ok("Audio separado del video en una pista independiente.");
			}

			case "zoom_timeline": {
				// Timeline zoom is a view-state concern; report current state.
				return ok("El zoom del timeline se controla desde la UI.");
			}

			case "export_video": {
				const project = editor.project.getActiveOrNull();
				if (!project) return fail("No hay proyecto abierto para exportar.");
				const format = (str(payload.format) as "mp4" | "webm") ?? "mp4";
				const result = await editor.project.export({
					options: {
						format,
						quality: mapQuality({ resolution: str(payload.resolution) }),
						fps: project.settings.fps,
						includeAudio: true,
					},
				});
				if (result.cancelled) {
					editor.project.clearExportState();
					return fail("Exportación cancelada.");
				}
				if (!result.success || !result.buffer) {
					return fail(result.error ?? "La exportación falló.");
				}
				// Hand the rendered file to the browser so the user actually gets it
				// (saves to Downloads, or prompts for a location per browser settings).
				const filename = `${project.metadata.name}${getExportFileExtension({ format })}`;
				downloadBuffer({
					buffer: result.buffer,
					filename,
					mimeType: getExportMimeType({ format }),
				});
				editor.project.clearExportState();
				return ok(`Video exportado y descargado como "${filename}".`, {
					filename,
					bytes: result.buffer.byteLength,
				});
			}

			case "duplicate_clip": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip.");
				const dups = editor.timeline.duplicateElements({
					elements: [{ trackId, elementId }],
				});
				return dups.length > 0
					? ok("Clip duplicado.")
					: fail("No se pudo duplicar el clip.");
			}

			case "delete_segment": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip.");
				const from = toTicks(
					num(payload.from ?? payload.start ?? payload.startTime, 0),
				);
				const to = toTicks(
					num(payload.to ?? payload.end ?? payload.endTime, 0),
				);
				if (to <= from)
					return fail("Rango inválido: 'to' debe ser mayor que 'from'.");
				// Cut at the end first (keeps positions stable), then at the start; the
				// piece returned by the second split IS the [from, to) segment.
				editor.timeline.splitElements({
					elements: [{ trackId, elementId }],
					splitTime: to,
				});
				const middle = editor.timeline.splitElements({
					elements: [{ trackId, elementId }],
					splitTime: from,
				});
				if (middle.length === 0) return fail("No se pudo aislar el segmento.");
				editor.timeline.deleteElements({ elements: middle });
				return ok("Segmento eliminado.");
			}

			case "set_transform": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip.");
				const [match] = editor.timeline.getElementsWithTracks({
					elements: [{ trackId, elementId }],
				});
				const base = match?.element as { transform?: Transform } | undefined;
				if (!base?.transform)
					return fail("Este elemento no admite zoom/rotación/escala.");
				const t = base.transform;
				// Uniform "scale"/"zoom" applies to both axes unless scaleX/scaleY given.
				const uniform =
					payload.scale != null
						? num(payload.scale, t.scaleX)
						: payload.zoom != null
							? num(payload.zoom, t.scaleX)
							: undefined;
				const transform: Transform = {
					scaleX: num(payload.scaleX ?? uniform, t.scaleX),
					scaleY: num(payload.scaleY ?? uniform, t.scaleY),
					rotate: num(payload.rotate ?? payload.rotation, t.rotate),
					position: {
						x: num(payload.positionX ?? payload.x, t.position.x),
						y: num(payload.positionY ?? payload.y, t.position.y),
					},
				};
				editor.timeline.updateElements({
					updates: [{ trackId, elementId, patch: { transform } as never }],
				});
				return ok("Transformación aplicada.");
			}

			case "fade": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				const trackId = resolveTrack({ elementId });
				if (!trackId) return fail("No se encontró el clip.");
				const [match] = editor.timeline.getElementsWithTracks({
					elements: [{ trackId, elementId }],
				});
				if (!match) return fail("No se encontró el clip.");
				const el = match.element;
				const span = el.duration;
				const isAudio = el.type === "audio";
				// Audio fades its volume; visual clips fade their opacity.
				const path: "opacity" | "volume" = isAudio ? "volume" : "opacity";
				const full =
					isAudio && "volume" in el && typeof el.volume === "number"
						? el.volume
						: 1;
				// "type": in | out | both. Default both when only a duration is given.
				const type = str(payload.type)?.toLowerCase();
				const requested = num(payload.duration ?? payload.seconds, 0);
				const fadeIn = toTicks(
					num(
						payload.fadeIn ??
							(type === "in" || type === "both" ? requested : 0),
						0,
					),
				);
				const fadeOut = toTicks(
					num(
						payload.fadeOut ??
							(type === "out" || type === "both" ? requested : 0),
						0,
					),
				);
				const keyframes: Array<{
					trackId: string;
					elementId: string;
					propertyPath: "opacity" | "volume";
					time: number;
					value: number;
				}> = [];
				if (fadeIn > 0) {
					keyframes.push(
						{ trackId, elementId, propertyPath: path, time: 0, value: 0 },
						{
							trackId,
							elementId,
							propertyPath: path,
							time: Math.min(fadeIn, span),
							value: full,
						},
					);
				}
				if (fadeOut > 0) {
					keyframes.push(
						{
							trackId,
							elementId,
							propertyPath: path,
							time: Math.max(0, span - fadeOut),
							value: full,
						},
						{ trackId, elementId, propertyPath: path, time: span, value: 0 },
					);
				}
				if (keyframes.length === 0)
					return fail("Indica fadeIn y/o fadeOut (en segundos).");
				editor.timeline.upsertKeyframes({ keyframes });
				return ok("Fade aplicado.");
			}

			case "generate_subtitles": {
				const scene = editor.scenes.getActiveSceneOrNull();
				if (!scene) return fail("No hay proyecto abierto.");
				if (editor.timeline.getTotalDuration() <= 0)
					return fail("La línea de tiempo está vacía.");
				const audioBlob = await extractTimelineAudio({
					tracks: scene.tracks,
					mediaAssets: editor.media.getAssets(),
					totalDuration: editor.timeline.getTotalDuration(),
				});
				const { samples } = await decodeAudioToFloat32({
					audioBlob,
					sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
				});
				const lang = str(payload.language);
				const result = await transcriptionService.transcribe({
					audioData: samples,
					language: lang && lang !== "auto" ? (lang as never) : undefined,
				});
				const chunks = buildCaptionChunks({ segments: result.segments });
				const createdTrackId = insertCaptionChunksAsTextTrack({
					editor,
					captions: chunks,
				});
				return createdTrackId
					? ok(`Subtítulos automáticos generados (${chunks.length} líneas).`)
					: fail("No se generaron subtítulos (¿el audio tiene voz?).");
			}

			case "export_subtitles": {
				const snapshot = getEditorSnapshot();
				const cues = snapshot.elements
					.filter(
						(e) => e.type === "text" && (e.content ?? "").trim().length > 0,
					)
					.sort((a, b) => a.startTime - b.startTime);
				if (cues.length === 0)
					return fail("No hay subtítulos/textos para exportar.");
				const srt = cues
					.map((cue, i) => {
						const start = toSrtTimestamp(cue.startTime);
						const end = toSrtTimestamp(cue.startTime + cue.duration);
						return `${i + 1}\n${start} --> ${end}\n${(cue.content ?? "").trim()}\n`;
					})
					.join("\n");
				const name = (snapshot.projectName ?? "subtitulos").replace(
					/[^\w.-]+/g,
					"_",
				);
				downloadTextFile({
					filename: `${name}.srt`,
					content: srt,
					mime: "application/x-subrip",
				});
				return ok(
					`Subtítulos exportados (${cues.length} líneas) como ${name}.srt.`,
				);
			}

			case "add_sound_effect": {
				const query = str(
					payload.query ?? payload.q ?? payload.effect ?? payload.name,
				);
				if (!query)
					return fail("¿Qué efecto de sonido buscas? (p. ej. 'explosión')");
				const scene = editor.scenes.getActiveSceneOrNull();
				if (!scene) return fail("No hay proyecto abierto.");

				// 1. Search Freesound through our own API route (handles auth + filters).
				const searchRes = await fetch(
					`/api/sounds/search?type=effects&page_size=10&sort=downloads&q=${encodeURIComponent(query)}`,
				);
				if (!searchRes.ok)
					return fail(
						`No se pudo buscar el efecto (status ${searchRes.status}).`,
					);
				const searchData = (await searchRes.json()) as {
					results?: Array<{
						name: string;
						previewUrl?: string;
						duration: number;
					}>;
				};
				const sound = searchData.results?.find((s) => s.previewUrl);
				if (!sound?.previewUrl)
					return fail(`No encontré ningún efecto para "${query}".`);

				// 2. Download + decode the preview (gives the editor a playable buffer).
				const audioRes = await fetch(sound.previewUrl);
				if (!audioRes.ok)
					return fail("No se pudo descargar el audio del efecto.");
				const arrayBuffer = await audioRes.arrayBuffer();
				const audioContext = new AudioContext();
				const buffer = await audioContext.decodeAudioData(arrayBuffer);

				// 3. Place it. Default to the playhead; honor an explicit start/range.
				const startTime =
					payload.timelineStart != null ||
					payload.from != null ||
					payload.start != null
						? toTicks(
								num(payload.timelineStart ?? payload.from ?? payload.start, 0),
							)
						: editor.playback.getCurrentTime();
				const naturalDuration = Math.max(1, toTicks(num(sound.duration, 2)));

				// Target span: from start to the given end. With no end, use the clip's
				// natural length.
				const endRaw = payload.to ?? payload.end ?? payload.timelineEnd;
				const desiredSpan =
					endRaw != null
						? toTicks(num(endRaw, 0)) - startTime
						: naturalDuration;
				if (desiredSpan <= 0)
					return fail("El rango del efecto es inválido ('to' <= inicio).");

				// Cover the span with back-to-back copies: shorter span => one trimmed
				// copy; longer span => the effect repeats (looping) until filled, the
				// last copy trimmed to land exactly on the end.
				const segments: Array<{ offset: number; duration: number }> = [];
				for (
					let covered = 0;
					covered < desiredSpan;
					covered += naturalDuration
				) {
					segments.push({
						offset: covered,
						duration: Math.min(naturalDuration, desiredSpan - covered),
					});
				}

				// First copy via auto placement (finds-or-creates the audio track), the
				// rest explicitly on that same track so they sit back-to-back.
				let audioTrackId: string | null = null;
				for (const seg of segments) {
					const copy = buildLibraryAudioElement({
						sourceUrl: sound.previewUrl,
						name: sound.name,
						duration: naturalDuration,
						startTime: startTime + seg.offset,
						buffer,
					});
					if (seg.duration < naturalDuration) {
						copy.duration = seg.duration;
						copy.trimEnd = naturalDuration - seg.duration;
					}
					if (audioTrackId) {
						editor.timeline.insertElement({
							placement: { mode: "explicit", trackId: audioTrackId },
							element: copy,
						});
					} else {
						editor.timeline.insertElement({
							placement: { mode: "auto" },
							element: copy,
						});
						// Resolve the track the first copy landed on (by its start time).
						audioTrackId =
							editor.scenes
								.getActiveSceneOrNull()
								?.tracks.audio.find((t) =>
									t.elements.some((e) => e.startTime === startTime),
								)?.id ?? null;
					}
				}

				return segments.length > 1
					? ok(
							`Efecto "${sound.name}" añadido y repetido ${segments.length}× para cubrir el rango.`,
						)
					: ok(`Efecto "${sound.name}" añadido.`);
			}

			case "undo": {
				if (!editor.command.canUndo()) return fail("Nada para deshacer.");
				editor.command.undo();
				return ok("Acción deshecha.");
			}

			case "redo": {
				if (!editor.command.canRedo()) return fail("Nada para rehacer.");
				editor.command.redo();
				return ok("Acción rehecha.");
			}

			default:
				return fail(`Acción no soportada: ${action}`);
		}
	} catch (err) {
		return fail(err instanceof Error ? err.message : "Error desconocido.");
	}
}
