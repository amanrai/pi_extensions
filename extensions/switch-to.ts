import type { ExtensionAPI, SessionEntry, SessionTreeNode, SessionInfo } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

function shortPath(path: string, max = 58): string {
	if (path.length <= max) return path;
	return "…" + path.slice(-(max - 1));
}

function fmtDate(d: Date): string {
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function textFromContent(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (part?.type === "text") return part.text;
				if (part?.type === "thinking") return "[thinking]";
				if (part?.type === "toolCall") return `[tool: ${part.name}]`;
				if (part?.type === "image") return "[image]";
				return "";
			})
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

function entryTitle(entry: SessionEntry): string {
	if (entry.type === "message") {
		const msg: any = entry.message;
		const role = msg.role ?? "message";
		if (role === "user") return `user: ${textFromContent(msg.content)}`;
		if (role === "assistant") return `assistant: ${textFromContent(msg.content)}`;
		if (role === "toolResult") return `tool:${msg.toolName ?? "?"} ${textFromContent(msg.content)}`;
		if (role === "bashExecution") return `bash: ${msg.command ?? ""}`;
		if (role === "custom") return `custom:${msg.customType ?? "?"} ${textFromContent(msg.content)}`;
		return `${role}: ${textFromContent(msg.content)}`;
	}
	if (entry.type === "model_change") return `model: ${entry.provider}/${entry.modelId}`;
	if (entry.type === "thinking_level_change") return `thinking: ${entry.thinkingLevel}`;
	if (entry.type === "compaction") return `compaction: ${entry.summary}`;
	if (entry.type === "branch_summary") return `branch summary: ${entry.summary}`;
	if (entry.type === "custom") return `custom:${entry.customType}`;
	if (entry.type === "custom_message") return `custom message:${entry.customType} ${textFromContent(entry.content)}`;
	if (entry.type === "label") return `label: ${entry.label ?? "cleared"}`;
	if (entry.type === "session_info") return `name: ${entry.name ?? ""}`;
	return entry.type;
}

function compact(s: string, max = 92): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

function flattenTree(nodes: SessionTreeNode[]) {
	const rows: Array<{ label: string; id: string }> = [];
	function walk(node: SessionTreeNode, prefix: string, isLast: boolean) {
		const branch = prefix ? (isLast ? "└─ " : "├─ ") : "";
		const label = node.label ? ` [${node.label}]` : "";
		rows.push({
			id: node.entry.id,
			label: `${branch}${compact(entryTitle(node.entry))}${label}  · ${node.entry.id}`,
		});
		const childPrefix = prefix + (prefix ? (isLast ? "   " : "│  ") : "");
		node.children.forEach((child, i) => walk(child, childPrefix, i === node.children.length - 1));
	}
	nodes.forEach((node, i) => walk(node, "", i === nodes.length - 1));
	return rows;
}

function sessionLabel(session: SessionInfo, index: number): string {
	const name = session.name || compact(session.firstMessage || "Untitled session", 52);
	const cwd = session.cwd ? shortPath(session.cwd, 42) : "unknown cwd";
	return `${String(index + 1).padStart(2, "0")}. ${name}  · ${fmtDate(session.modified)}  · ${session.messageCount} msgs  · ${cwd}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("switchTo", {
		description: "Pick an old session, then resume from any point in its tree",
		handler: async (args, ctx) => {
			ctx.ui.notify("Loading sessions for this folder…", "info");
			const all = await SessionManager.list(ctx.cwd);
			const current = ctx.sessionManager.getSessionFile();
			const sessions = all
				.filter((s) => s.path !== current)
				.sort((a, b) => b.modified.getTime() - a.modified.getTime());

			if (sessions.length === 0) {
				ctx.ui.notify("No old sessions found.", "warning");
				return;
			}

			const sessionChoices = sessions.map((s, i) => sessionLabel(s, i));
			const pickedSessionLabel = args?.trim()
				? sessionChoices.find((label) => label.toLowerCase().includes(args.trim().toLowerCase()))
				: await ctx.ui.select("Switch to session:", sessionChoices);
			if (!pickedSessionLabel) return;

			const session = sessions[sessionChoices.indexOf(pickedSessionLabel)];
			if (!session) return;

			let manager: SessionManager;
			try {
				manager = SessionManager.open(session.path);
			} catch (err) {
				ctx.ui.notify(`Failed to open session: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			const rows = flattenTree(manager.getTree());
			if (rows.length === 0) {
				const result = await ctx.switchSession(session.path);
				if (!result.cancelled) ctx.ui.notify("Switched to empty session.", "info");
				return;
			}

			const leafId = manager.getLeafId();
			const choices = [
				`Current leaf  · ${leafId ?? "empty"}`,
				...rows.map((r, i) => `${String(i + 1).padStart(3, "0")}. ${r.label}`),
			];
			const pickedEntryLabel = await ctx.ui.select("Resume from tree point:", choices);
			if (!pickedEntryLabel) return;

			const selectedId = pickedEntryLabel === choices[0]
				? leafId
				: rows[choices.indexOf(pickedEntryLabel) - 1]?.id;

			const result = await ctx.switchSession(session.path, {
				withSession: async (newCtx) => {
					if (selectedId && selectedId !== newCtx.sessionManager.getLeafId()) {
						await newCtx.navigateTree(selectedId, { summarize: false });
					}
					newCtx.ui.notify(`Inhabiting: ${session.name || shortPath(session.path)}`, "info");
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Session switch cancelled.", "warning");
			}
		},
	});
}
