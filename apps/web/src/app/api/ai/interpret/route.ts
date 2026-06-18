// Server route: translates a natural-language editing request into ONE structured
// skill action via MiniMax. Execution happens on the client (EditorCore lives in
// the browser), so this route only returns { action, payload }.

import { NextResponse } from "next/server";
import { callMinimax, stripThinking } from "@/lib/minimax/client";
import { SKILL_SYSTEM_PROMPT, SKILL_TOOLS } from "@/lib/minimax/tools";

interface HistoryMessage {
	role: "user" | "assistant";
	content: string;
}

interface InterpretBody {
	message?: string;
	snapshot?: unknown;
	history?: HistoryMessage[];
}

export async function POST(request: Request) {
	let body: InterpretBody;
	try {
		body = (await request.json()) as InterpretBody;
	} catch {
		return NextResponse.json(
			{ success: false, error: "Invalid JSON" },
			{ status: 400 },
		);
	}

	const message = typeof body.message === "string" ? body.message.trim() : "";
	if (!message) {
		return NextResponse.json(
			{ success: false, error: "Empty message" },
			{ status: 422 },
		);
	}

	const stateContext = body.snapshot
		? `Current editor state:\n${JSON.stringify(body.snapshot, null, 2)}\n\n`
		: "No project state provided.\n\n";

	// Keep the last 5 exchanges (10 messages) of context for follow-up clarity.
	const history = Array.isArray(body.history)
		? body.history
				.filter(
					(m) =>
						(m?.role === "user" || m?.role === "assistant") &&
						typeof m.content === "string",
				)
				.slice(-10)
				.map((m) => ({ role: m.role, content: m.content }))
		: [];

	try {
		const response = await callMinimax({
			messages: [
				{ role: "system", content: SKILL_SYSTEM_PROMPT },
				...history,
				{ role: "user", content: `${stateContext}User request: ${message}` },
			],
			tools: SKILL_TOOLS,
		});

		const choice = response.choices?.[0];
		const toolCalls = choice?.message?.tool_calls ?? [];
		if (toolCalls.length === 0) {
			// Not an editing action (greeting, identity question, small talk): the
			// model answered conversationally. Return that reply directly.
			const reply = stripThinking(choice?.message?.content ?? "");
			return NextResponse.json({
				success: true,
				actions: [],
				reply:
					reply ||
					"No pude convertir eso en una acción de edición. ¿Puedes reformularlo?",
			});
		}

		// A request may decompose into several ordered actions (composite edits).
		const actions = toolCalls.map((tc) => {
			let payload: Record<string, unknown> = {};
			try {
				payload = JSON.parse(tc.function.arguments || "{}");
			} catch {
				payload = {};
			}
			return { action: tc.function.name, payload };
		});

		return NextResponse.json({
			success: true,
			actions,
			// Back-compat: first action also exposed directly.
			action: actions[0].action,
			payload: actions[0].payload,
		});
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
