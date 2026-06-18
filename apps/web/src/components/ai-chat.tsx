"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import { getEditorSnapshot } from "@/lib/skill/state";
import { executeSkillAction } from "@/lib/skill/executor";
import type { SkillActionName } from "@/lib/skill/types";

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	error?: boolean;
}

function uid() {
	return Math.random().toString(36).slice(2);
}

export function AiChat() {
	const [open, setOpen] = useState(false);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [input, setInput] = useState("");
	const [loading, setLoading] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		scrollRef.current?.scrollTo({
			top: scrollRef.current.scrollHeight,
			behavior: "smooth",
		});
	}, [messages, loading]);

	// Grow the textarea with its content (ChatGPT-style), capped at ~6 lines.
	function autoResize() {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
	}

	async function send() {
		const text = input.trim();
		if (!text || loading) return;

		// Recent conversation context (last 5 exchanges = up to 10 messages) so the
		// model can resolve follow-ups like "no, me refiero a…".
		const history = messages.slice(-10).map((m) => ({
			role: m.role,
			content: m.content,
		}));

		setMessages((m) => [...m, { id: uid(), role: "user", content: text }]);
		setInput("");
		if (textareaRef.current) textareaRef.current.style.height = "auto";
		setLoading(true);

		try {
			// 1. Snapshot of the live editor (client-side) so the LLM gets real IDs
			const snapshot = getEditorSnapshot();

			// 2. Translate NL -> structured action via MiniMax (server)
			const res = await fetch("/api/ai/interpret", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: text, snapshot, history }),
			});
			const data = await res.json();

			if (!data.success) {
				setMessages((m) => [
					...m,
					{
						id: uid(),
						role: "assistant",
						content: data.error ?? "No se pudo procesar la instrucción.",
						error: true,
					},
				]);
				return;
			}

			// 3. Execute the action(s) against EditorCore (client-side), in order.
			// A composite request may decompose into several ordered actions.
			const actions: Array<{
				action: string;
				payload?: Record<string, unknown>;
			}> = Array.isArray(data.actions)
				? data.actions
				: data.action
					? [{ action: data.action, payload: data.payload }]
					: [];

			// Conversational reply (no editing action — e.g. "¿qué IA eres?").
			if (actions.length === 0) {
				setMessages((m) => [
					...m,
					{
						id: uid(),
						role: "assistant",
						content: data.reply ?? "¿En qué te ayudo con tu video?",
					},
				]);
				return;
			}

			const outcomes: string[] = [];
			const results: Array<{ action: string; ok: boolean; message: string }> =
				[];
			for (const act of actions) {
				const result = await executeSkillAction({
					action: act.action as SkillActionName,
					payload: act.payload ?? {},
				});
				outcomes.push(result.success ? result.message : `⚠️ ${result.error}`);
				results.push({
					action: act.action,
					ok: result.success,
					message: result.success ? result.message : result.error,
				});
			}

			// 4. Let the AI phrase the confirmation in natural language. Fall back to
			// the executor's own messages if the model call fails.
			let reply = outcomes.join("\n");
			try {
				const respondRes = await fetch("/api/ai/respond", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ message: text, results }),
				});
				const respondData = await respondRes.json();
				if (respondData.success && typeof respondData.reply === "string") {
					reply = respondData.reply;
				}
			} catch {
				// keep the fallback reply
			}

			setMessages((m) => [
				...m,
				{ id: uid(), role: "assistant", content: reply },
			]);
		} catch (err) {
			setMessages((m) => [
				...m,
				{
					id: uid(),
					role: "assistant",
					content: err instanceof Error ? err.message : "Error de red.",
					error: true,
				},
			]);
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="fixed bottom-16 right-4 z-50 flex flex-col items-end gap-2">
			{open && (
				<div
					data-testid="ai-chat-panel"
					className="flex h-[28rem] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
				>
					<div className="flex items-center justify-between border-b border-border px-3 py-2">
						<div className="flex items-center gap-1.5">
							<Sparkles className="size-3.5 text-primary" />
							<span className="text-xs font-medium">Asistente de edición</span>
						</div>
						<Button
							variant="ghost"
							size="icon"
							onClick={() => setOpen(false)}
							aria-label="Cerrar"
						>
							<X className="size-3.5" />
						</Button>
					</div>

					<div
						ref={scrollRef}
						className="flex-1 space-y-2 overflow-y-auto px-3 py-3"
					>
						{messages.length === 0 && (
							<div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
								<Bot className="size-6" />
								<p className="text-xs">
									Dame instrucciones en lenguaje natural.
									<br />
									Ej: "agrega un texto al inicio", "corta los primeros 3
									segundos", "añade música de fondo".
								</p>
							</div>
						)}
						{messages.map((msg) => (
							<div
								key={msg.id}
								className={cn(
									"flex",
									msg.role === "user" ? "justify-end" : "justify-start",
								)}
							>
								<div
									className={cn(
										"max-w-[85%] rounded-md px-2.5 py-1.5 text-xs leading-relaxed",
										msg.role === "user"
											? "bg-foreground text-background"
											: msg.error
												? "bg-destructive/10 text-destructive"
												: "bg-accent text-foreground",
									)}
								>
									{msg.content}
								</div>
							</div>
						))}
						{loading && (
							<div className="flex justify-start">
								<div className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs text-muted-foreground">
									<Loader2 className="size-3 animate-spin" />
									Pensando…
								</div>
							</div>
						)}
					</div>

					<div className="border-t border-border p-2">
						<div className="flex items-end gap-1.5 rounded-md border border-border bg-input/30 px-2 py-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
							<textarea
								ref={textareaRef}
								rows={1}
								value={input}
								onChange={(e) => {
									setInput(e.target.value);
									autoResize();
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										send();
									}
								}}
								placeholder="Escribe una instrucción…"
								disabled={loading}
								data-testid="ai-chat-input"
								className="max-h-[140px] min-h-[1.25rem] w-full resize-none self-center bg-transparent text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
							/>
							<Button
								size="icon"
								onClick={send}
								disabled={loading || !input.trim()}
								data-testid="ai-chat-send"
								aria-label="Enviar"
								className="shrink-0"
							>
								<Send className="size-3.5" />
							</Button>
						</div>
					</div>
				</div>
			)}

			<Button
				size="icon"
				className="size-10 rounded-full shadow-lg"
				onClick={() => setOpen((o) => !o)}
				data-testid="ai-chat-toggle"
				aria-label="Asistente de edición IA"
			>
				{open ? <X className="size-4" /> : <Sparkles className="size-4" />}
			</Button>
		</div>
	);
}
