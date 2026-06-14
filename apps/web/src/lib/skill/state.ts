// Reads a serializable snapshot of the current editor state from EditorCore.
// Used both for the `get_project_state` action and to give the LLM the real
// element/track IDs it needs to target operations.

import { EditorCore } from "@/core";
import type { SceneTracks, TimelineTrack } from "@/lib/timeline";
import { TICKS_PER_SECOND } from "@/lib/wasm/ticks";
import type { AssetSummary, EditorSnapshot, ElementSummary } from "./types";

// EditorCore stores time in integer "ticks". The skill/LLM works in seconds.
const toSeconds = (ticks: number): number =>
	Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000;

function flattenTracks({ tracks }: { tracks: SceneTracks }): TimelineTrack[] {
	return [tracks.main, ...tracks.overlay, ...tracks.audio];
}

export function getEditorSnapshot(): EditorSnapshot {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const scene = editor.scenes.getActiveSceneOrNull();

	const elements: ElementSummary[] = [];
	if (scene) {
		for (const track of flattenTracks({ tracks: scene.tracks })) {
			for (const element of track.elements) {
				const volume =
					"volume" in element && typeof element.volume === "number"
						? element.volume
						: undefined;
				elements.push({
					elementId: element.id,
					trackId: track.id,
					trackType: track.type,
					type: element.type,
					name: element.name,
					content:
						element.type === "text"
							? (element as { content?: string }).content
							: undefined,
					startTime: toSeconds(element.startTime),
					duration: toSeconds(element.duration),
					trimStart: toSeconds(element.trimStart),
					trimEnd: toSeconds(element.trimEnd),
					volume,
				});
			}
		}
	}

	const assets: AssetSummary[] = editor.media.getAssets().map((a) => ({
		mediaId: a.id,
		name: a.name,
		type: a.type,
		duration: a.duration ?? 0,
		hasAudio: a.hasAudio ?? a.type === "audio",
	}));

	return {
		hasProject: project != null,
		projectId: project?.metadata.id ?? null,
		projectName: project?.metadata.name ?? null,
		canvasSize: project
			? {
					width: project.settings.canvasSize.width,
					height: project.settings.canvasSize.height,
				}
			: null,
		totalDuration: toSeconds(editor.timeline.getTotalDuration()),
		canUndo: editor.command.canUndo(),
		canRedo: editor.command.canRedo(),
		elements,
		assets,
	};
}
