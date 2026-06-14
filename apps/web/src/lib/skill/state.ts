// Reads a serializable snapshot of the current editor state from EditorCore.
// Used both for the `get_project_state` action and to give the LLM the real
// element/track IDs it needs to target operations.

import { EditorCore } from "@/core";
import type { SceneTracks, TimelineTrack } from "@/lib/timeline";
import type { EditorSnapshot, ElementSummary } from "./types";

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
					startTime: element.startTime,
					duration: element.duration,
					trimStart: element.trimStart,
					trimEnd: element.trimEnd,
					volume,
				});
			}
		}
	}

	return {
		hasProject: project != null,
		projectId: project?.metadata.id ?? null,
		projectName: project?.metadata.name ?? null,
		totalDuration: editor.timeline.getTotalDuration(),
		canUndo: editor.command.canUndo(),
		canRedo: editor.command.canRedo(),
		elements,
	};
}
