// MiniMax international platform (OpenAI-compatible) client. Server-side only.

const MINIMAX_API_URL =
	process.env.MINIMAX_API_URL ?? "https://api.minimax.io/v1/chat/completions";
const MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M2.7";

export interface MinimaxMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface MinimaxTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface MinimaxToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface MinimaxResponse {
	choices: Array<{
		message: { role: string; content: string; tool_calls?: MinimaxToolCall[] };
		finish_reason: string;
	}>;
	base_resp?: { status_code: number; status_msg: string };
}

export async function callMinimax({
	messages,
	tools,
}: {
	messages: MinimaxMessage[];
	tools: MinimaxTool[];
}): Promise<MinimaxResponse> {
	const apiKey = process.env.MINIMAX_API_KEY;
	if (!apiKey) throw new Error("MINIMAX_API_KEY is not set");

	const requestBody = JSON.stringify({
		model: MODEL,
		messages,
		tools,
		tool_choice: "auto",
	});

	// Retry transient network failures ("fetch failed") a couple of times.
	let response: Response | undefined;
	let lastErr: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			response = await fetch(MINIMAX_API_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: requestBody,
				signal: AbortSignal.timeout(60000),
			});
			break;
		} catch (err) {
			lastErr = err;
			await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
		}
	}

	if (!response) {
		throw new Error(
			`MiniMax request failed: ${lastErr instanceof Error ? lastErr.message : "network error"}`,
		);
	}

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`MiniMax API error ${response.status}: ${body}`);
	}

	const data = (await response.json()) as MinimaxResponse;
	if (data.base_resp && data.base_resp.status_code !== 0) {
		throw new Error(
			`MiniMax error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`,
		);
	}
	return data;
}
