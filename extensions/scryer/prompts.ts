import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RecorderState, ToolEvent } from "./types.ts";

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => part?.text ?? "").filter(Boolean).join("\n");
}

export function buildConversationText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	const sections: string[] = [];
	for (const entry of entries.slice(-80) as any[]) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		if (!["user", "assistant", "toolResult"].includes(entry.message.role)) continue;
		const text = contentText(entry.message.content).trim();
		if (text) sections.push(`${entry.message.role.toUpperCase()}:\n${text}`);
	}
	return sections.join("\n\n");
}

export function summaryPrompt(
	ctx: ExtensionContext,
	reason: string,
	endSession: boolean,
	state: RecorderState | undefined,
	recentTools: ToolEvent[],
	recentUserPrompts: string[],
): string {
	const toolLines = recentTools.slice(-40).map((t) => `- ${t.name}: ${t.ok === false ? "failed" : "used"}${t.error ? ` (${t.error})` : ""}`);
	return [
		"Update the rolling work summary for this Pi coding session.",
		"Be concise but include narrative plus tool details, files touched, commands run, decisions, current state, and next steps.",
		endSession ? "This is an end-of-session summary. Capture final state clearly." : "This is a rolling summary update.",
		`Reason: ${reason}`,
		`CWD: ${state?.cwd ?? ctx.cwd}`,
		"",
		"Existing summary:",
		state?.summary || "(none)",
		"",
		"Recent user prompts:",
		...recentUserPrompts.slice(-12).map((p) => `- ${p.replace(/\s+/g, " ").slice(0, 300)}`),
		"",
		"Recent tool activity:",
		...(toolLines.length ? toolLines : ["- none recorded"]),
		"",
		"Recent conversation:",
		buildConversationText(ctx),
	].join("\n");
}

export function updateTicketPrompt(
	ctx: ExtensionContext,
	task: any,
	recentTools: ToolEvent[],
	recentUserPrompts: string[],
): string {
	const toolLines = recentTools.slice(-40).map((t) => `- ${t.name}: ${t.ok === false ? "failed" : "used"}${t.error ? ` (${t.error})` : ""}`);
	return [
		"Revise the existing Scryer ticket description to reflect the current Pi session state.",
		"Do not produce a separate status report. Return ONLY the full replacement markdown for the ticket description.",
		"Preserve useful existing structure and decisions. Merge in new facts, current state, files touched, and next steps.",
		"Remove stale claims only when contradicted by the session.",
		`Ticket: ${task.title} [${task.status}]`,
		"",
		"Existing ticket description:",
		String(task.description_md ?? ""),
		"",
		"Recent user prompts:",
		...recentUserPrompts.slice(-12).map((p) => `- ${p.replace(/\s+/g, " ").slice(0, 300)}`),
		"",
		"Recent tool activity:",
		...(toolLines.length ? toolLines : ["- none recorded"]),
		"",
		"Recent conversation:",
		buildConversationText(ctx),
	].join("\n");
}
