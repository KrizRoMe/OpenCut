// Server route: given the user's request and what the editor actually did
// (the executed actions + their outcomes), ask MiniMax to phrase a short,
// natural confirmation. Keeps the assistant's voice consistent instead of
// echoing the executor's fixed strings.

import { NextResponse } from "next/server";
import { callMinimax, stripThinking } from "@/lib/minimax/client";
import { ASSISTANT_IDENTITY } from "@/lib/minimax/tools";

interface ExecutedAction {
	action: string;
	ok: boolean;
	message: string;
}

interface RespondBody {
	message?: string;
	results?: ExecutedAction[];
}

const RESPOND_SYSTEM_PROMPT = `You are the editing assistant for OpenCut, a video editor.
The user gave an instruction and the editor already executed it. You are given the user's request and the technical outcome of each action.
Write a SHORT, friendly confirmation (1-2 sentences) describing what was done, in the SAME language the user used (Spanish or English).
Do not invent actions that were not performed. If an action failed, say so plainly and, if useful, suggest what to try.
Speak naturally — do not output JSON, tool names, or element IDs.
Never output <think> blocks or your reasoning — only the final answer.
${ASSISTANT_IDENTITY}`;

export async function POST(request: Request) {
	let body: RespondBody;
	try {
		body = (await request.json()) as RespondBody;
	} catch {
		return NextResponse.json(
			{ success: false, error: "Invalid JSON" },
			{ status: 400 },
		);
	}

	const message = typeof body.message === "string" ? body.message.trim() : "";
	const results = Array.isArray(body.results) ? body.results : [];
	if (!message || results.length === 0) {
		return NextResponse.json(
			{ success: false, error: "Missing message or results" },
			{ status: 422 },
		);
	}

	const outcomeLines = results
		.map((r) => `- ${r.action}: ${r.ok ? "OK" : "FAILED"} — ${r.message}`)
		.join("\n");

	try {
		const response = await callMinimax({
			messages: [
				{ role: "system", content: RESPOND_SYSTEM_PROMPT },
				{
					role: "user",
					content: `User request: ${message}\n\nActions executed:\n${outcomeLines}\n\nWrite the confirmation.`,
				},
			],
		});

		const reply = stripThinking(response.choices?.[0]?.message?.content ?? "");
		if (!reply) {
			return NextResponse.json(
				{ success: false, error: "Empty reply" },
				{ status: 400 },
			);
		}
		return NextResponse.json({ success: true, reply });
	} catch (err) {
		return NextResponse.json(
			{
				success: false,
				error: err instanceof Error ? err.message : "AI error",
			},
			{ status: 400 },
		);
	}
}
