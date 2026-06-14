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
import { getEditorSnapshot } from "./state";
import type { AssetSummary, SkillAction, SkillResult } from "./types";

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
						duration,
						fontSize: payload.fontSize ? num(payload.fontSize, 48) : undefined,
						color: str(payload.color),
						textAlign: str(payload.align) as never,
					},
					startTime,
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
					duration,
					startTime,
				});
				editor.timeline.insertElement({ element, placement: { mode: "auto" } });
				return ok("Audio añadido.");
			}

			case "trim_clip": {
				const elementId = str(payload.clipId ?? payload.elementId);
				if (!elementId) return fail("Falta elementId del clip.");
				editor.timeline.updateElementTrim({
					elementId,
					trimStart: num(payload.trimStart ?? payload.sourceStart, 0),
					trimEnd: num(payload.trimEnd, 0),
					startTime:
						payload.timelineStart != null
							? num(payload.timelineStart, 0)
							: undefined,
					duration:
						payload.timelineDuration != null
							? num(payload.timelineDuration, 0)
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
					splitTime: num(payload.splitAt ?? payload.splitTime, 0),
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
					newStartTime: num(payload.timelineStart ?? payload.newStartTime, 0),
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
						duration: num(payload.sourceDuration ?? payload.duration, 30),
						startTime,
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
					duration: asset.duration || num(payload.duration, 30),
					startTime,
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
					duration: asset.duration || num(payload.duration, 5),
					startTime: num(payload.timelineStart ?? payload.startTime, 0),
				});
				editor.timeline.insertElement({ element, placement: { mode: "auto" } });
				return ok(`"${asset.name}" añadido al timeline.`);
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
