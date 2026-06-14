// Client-side skill executor: maps high-level semantic actions to operations on
// the EditorCore singleton. This is the UI-decoupled "command layer" the AI chat
// (or any future MCP tool) calls. Runs in the browser because EditorCore and its
// IndexedDB-backed state live there.

import { EditorCore } from "@/core";
import {
	buildElementFromMedia,
	buildLibraryAudioElement,
	buildTextElement,
} from "@/lib/timeline/element-utils";
import type { ExportQuality } from "@/lib/export";
import { TICKS_PER_SECOND } from "@/lib/wasm/ticks";
import { getEditorSnapshot } from "./state";
import type { AssetSummary, SkillAction, SkillResult } from "./types";

// The LLM/skill speaks in seconds; EditorCore stores integer "ticks".
const toTicks = (seconds: number): number => Math.round(seconds * TICKS_PER_SECOND);

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
	return snapshot.elements.find((e) => e.elementId === elementId)?.trackId ?? null;
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

function mapAspect({ ratio }: { ratio?: string }): { width: number; height: number } {
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
				const element = buildTextElement({
					raw: {
						content,
						duration: toTicks(duration),
						fontSize: payload.fontSize ? num(payload.fontSize, 48) : undefined,
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
				if (payload.fontSize != null) patch.fontSize = num(payload.fontSize, 48);
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
				editor.timeline.updateElementTrim({
					elementId,
					trimStart: toTicks(num(payload.trimStart ?? payload.sourceStart, 0)),
					trimEnd: toTicks(num(payload.trimEnd, 0)),
					startTime:
						payload.timelineStart != null
							? toTicks(num(payload.timelineStart, 0))
							: undefined,
					duration:
						payload.timelineDuration != null
							? toTicks(num(payload.timelineDuration, 0))
							: undefined,
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
					newStartTime: toTicks(num(payload.timelineStart ?? payload.newStartTime, 0)),
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
				editor.timeline.updateElements({
					updates: [{ trackId, elementId, patch: { volume } as never }],
				});
				return ok(`Volumen ajustado a ${volume}.`);
			}

			case "add_background_music": {
				// Use an imported audio asset (or a URL) as background music.
				const url = str(payload.url ?? payload.sourceUrl);
				const startTime = num(payload.timelineStart ?? payload.startTime, 0);
				if (url) {
					const element = buildLibraryAudioElement({
						sourceUrl: url,
						name: str(payload.name) ?? "Música de fondo",
						duration: toTicks(num(payload.sourceDuration ?? payload.duration, 30)),
						startTime: toTicks(startTime),
					});
					editor.timeline.insertElement({ element, placement: { mode: "auto" } });
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
				const requested = str(payload.mediaId ?? payload.assetName ?? payload.name);
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
					startTime: toTicks(num(payload.timelineStart ?? payload.startTime, 0)),
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
				const videoEls: Array<{ trackId: string; el: { id: string; startTime: number; duration: number } }> =
					[];
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

				const atTicks = toTicks(num(payload.atSeconds ?? payload.splitAt ?? payload.timelineStart, 0));
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
							const onBase = t.id === base.trackId ? "✓" : `pista ${t.id.slice(0, 4)}`;
							layout.push(`${el.name.slice(0, 14)} [${s.toFixed(1)}–${e.toFixed(1)}s] ${onBase}`);
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
				const rate = Math.max(0.25, Math.min(4, num(payload.speed ?? payload.rate, 1)));
				editor.timeline.updateElementRetime({
					trackId,
					elementId,
					retime: { rate, maintainPitch: true },
				});
				return ok(`Velocidad cambiada a ${rate}x.`);
			}

			case "set_aspect_ratio": {
				const size = mapAspect({ ratio: str(payload.ratio ?? payload.aspect ?? payload.format) });
				await editor.project.updateSettings({
					settings: { canvasSize: size, canvasSizeMode: "custom" },
				});
				return ok(`Formato cambiado a ${size.width}×${size.height}.`);
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
				if (!elementId) return fail("No hay ningún clip de video para separar el audio.");
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
				const result = await editor.project.export({
					options: {
						format: (str(payload.format) as "mp4" | "webm") ?? "mp4",
						quality: mapQuality({ resolution: str(payload.resolution) }),
						includeAudio: true,
					},
				});
				if (!result.success) {
					return fail(result.error ?? "La exportación falló.");
				}
				return ok("Exportación completada.", {
					bytes: result.buffer?.byteLength ?? 0,
				});
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
