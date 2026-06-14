// Server route: translates a natural-language editing request into ONE structured
// skill action via MiniMax. Execution happens on the client (EditorCore lives in
// the browser), so this route only returns { action, payload }.

import { NextResponse } from "next/server";
import { callMinimax } from "@/lib/minimax/client";
import { SKILL_SYSTEM_PROMPT, SKILL_TOOLS } from "@/lib/minimax/tools";

interface InterpretBody {
	message?: string;
	snapshot?: unknown;
}

export async function POST(request: Request) {
	let body: InterpretBody;
	try {
		body = (await request.json()) as InterpretBody;
	} catch {
		return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
	}

	const message = typeof body.message === "string" ? body.message.trim() : "";
	if (!message) {
		return NextResponse.json({ success: false, error: "Empty message" }, { status: 422 });
	}

	const stateContext = body.snapshot
		? `Current editor state:\n${JSON.stringify(body.snapshot, null, 2)}\n\n`
		: "No project state provided.\n\n";

	try {
		const response = await callMinimax({
			messages: [
				{ role: "system", content: SKILL_SYSTEM_PROMPT },
				{ role: "user", content: `${stateContext}User request: ${message}` },
			],
			tools: SKILL_TOOLS,
		});

		const choice = response.choices?.[0];
		const toolCall = choice?.message?.tool_calls?.[0];
		if (!toolCall) {
			return NextResponse.json(
				{
					success: false,
					error: "El asistente no pudo convertir la instrucción en una acción.",
					rawResponse: choice?.message?.content ?? "",
				},
				{ status: 400 },
			);
		}

		let payload: Record<string, unknown> = {};
		try {
			payload = JSON.parse(toolCall.function.arguments || "{}");
		} catch {
			return NextResponse.json(
				{ success: false, error: "No se pudieron leer los argumentos." },
				{ status: 400 },
			);
		}

		return NextResponse.json({
			success: true,
			action: toolCall.function.name,
			payload,
		});
	} catch (err) {
		return NextResponse.json(
			{ success: false, error: err instanceof Error ? err.message : "AI error" },
			{ status: 400 },
		);
	}
}
