import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface SessionTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface ProviderHeaders {
	status: number;
	at: number;
	headers: Record<string, string>;
}

const interestingHeaderPrefixes = [
	"x-ratelimit-",
	"openai-processing-ms",
	"anthropic-ratelimit-",
];

function fmtTokens(n: number | undefined | null): string {
	if (n === undefined || n === null || !Number.isFinite(n)) return "?";
	if (Math.abs(n) < 1000) return `${Math.round(n)}`;
	if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

function fmtMoney(n: number): string {
	return `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
}

function fmtDate(seconds: number | undefined | null): string | undefined {
	if (!seconds) return undefined;
	return new Date(seconds * 1000).toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function bar(percentLeft: number, width = 18): string {
	const clamped = Math.max(0, Math.min(100, percentLeft));
	const filled = Math.round((clamped / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatWindow(label: string, window: any, indent = "  "): string | undefined {
	if (!window) return undefined;
	const used = Number(window.used_percent ?? 0);
	const left = Math.max(0, Math.min(100, 100 - used));
	const reset = fmtDate(window.reset_at);
	return `${indent}${label.padEnd(7)} ${bar(left)}  ${left.toFixed(0).padStart(3)}%` +
		(reset ? `  ↺ ${reset}` : "");
}

function labelForWindow(name: string, window: any): string {
	const seconds = Number(window?.limit_window_seconds ?? 0);
	if (!seconds) return name;
	const mins = Math.round(seconds / 60);
	if (mins >= 60 * 24 * 6) return "weekly";
	if (mins >= 60) return `${Math.round(mins / 60)}h`;
	return `${mins}m`;
}

function usageFromMessage(message: AssistantMessage): SessionTotals {
	const usage: any = message.usage ?? {};
	const cost = usage.cost ?? {};
	return {
		input: Number(usage.input ?? 0),
		output: Number(usage.output ?? 0),
		cacheRead: Number(usage.cacheRead ?? usage.cache_read ?? 0),
		cacheWrite: Number(usage.cacheWrite ?? usage.cache_write ?? 0),
		cost: Number(cost.total ?? usage.costTotal ?? 0),
	};
}

function addTotals(a: SessionTotals, b: SessionTotals): SessionTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

async function fetchCodexUsage(): Promise<string | undefined> {
	let auth: any;
	try {
		auth = JSON.parse(await readFile(join(homedir(), ".codex", "auth.json"), "utf8"));
	} catch {
		return undefined;
	}

	const access = auth.tokens?.access_token;
	if (!access) return undefined;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${access}`,
		"User-Agent": "codex-cli",
		Accept: "application/json",
	};
	if (auth.tokens?.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;

	const res = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
	const text = await res.text();
	if (!res.ok) return `Codex limits: unavailable (${res.status})`;

	const data = JSON.parse(text);
	const lines: string[] = [];
	lines.push(`▸ Codex plan  ${data.plan_type ?? "unknown"}`);

	if (data.rate_limit) {
		const p = data.rate_limit.primary_window;
		const s = data.rate_limit.secondary_window;
		const pLine = formatWindow(labelForWindow("primary", p), p);
		const sLine = formatWindow(labelForWindow("secondary", s), s);
		if (pLine || sLine) lines.push("▸ Codex limits");
		if (pLine) lines.push(pLine);
		if (sLine) lines.push(sLine);
	} else {
		lines.push("Codex limits: not available");
	}

	if (data.credits) {
		const credits = data.credits.unlimited
			? "unlimited"
			: data.credits.has_credits
				? `${data.credits.balance ?? "unknown"}`
				: "disabled";
		lines.push(`▸ Credits     ${credits}`);
	}

	if (Array.isArray(data.additional_rate_limits) && data.additional_rate_limits.length > 0) {
		lines.push("▸ Additional limits");
		for (const limit of data.additional_rate_limits) {
			lines.push(`  ${limit.limit_name ?? limit.metered_feature ?? "unnamed"}`);
			const p = limit.rate_limit?.primary_window;
			const s = limit.rate_limit?.secondary_window;
			const pLine = formatWindow(labelForWindow("primary", p), p, "    ");
			const sLine = formatWindow(labelForWindow("secondary", s), s, "    ");
			if (pLine) lines.push(pLine);
			if (sLine) lines.push(sLine);
		}
	}

	return lines.join("\n");
}

function formatProviderHeaders(latest?: ProviderHeaders): string | undefined {
	if (!latest) return undefined;
	const kept = Object.entries(latest.headers).filter(([k]) =>
		interestingHeaderPrefixes.some((prefix) => k.toLowerCase().startsWith(prefix)),
	);
	if (kept.length === 0) return undefined;
	const age = Math.round((Date.now() - latest.at) / 1000);
	return [
		`Latest provider response: HTTP ${latest.status}, ${age}s ago`,
		...kept.map(([k, v]) => `  ${k}: ${v}`),
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let latestProviderHeaders: ProviderHeaders | undefined;

	pi.registerMessageRenderer("smart-status", (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
		const pretty = content
			.split("\n")
			.map((line) => {
				// Avoid low-contrast gray and lime-green bars on dark terminals.
				if (line.startsWith("╭") || line.startsWith("╰") || line.startsWith("│")) return theme.fg("accent", line);
				if (line.startsWith("▸")) return theme.fg("accent", line);
				return line
					.replace(/█+/g, (m) => theme.fg("accent", m))
					.replace(/░+/g, (m) => theme.fg("text", m));
			})
			.join("\n");
		return new Text(pretty, 1, 0);
	});

	pi.on("after_provider_response", (event) => {
		latestProviderHeaders = {
			status: event.status,
			at: Date.now(),
			headers: event.headers ?? {},
		};
	});

	pi.registerCommand("status", {
		description: "Show model, context, session usage, and provider quotas",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			const context = ctx.getContextUsage();
			let totals: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					totals = addTotals(totals, usageFromMessage(entry.message as AssistantMessage));
				}
			}

			const lines: string[] = [];
			lines.push("╭─ Pi Status");
			lines.push(`▸ Model       ${model ? `${model.provider}/${model.id}` : "unknown"}`);
			if (context) {
				const left = typeof context.percent === "number" ? Math.max(0, 100 - context.percent) : undefined;
				const contextBar = left === undefined ? "" : `  ${bar(left)}  ${left.toFixed(0)}% left`;
				lines.push(`▸ Context     ${fmtTokens(context.tokens)} / ${fmtTokens(model?.contextWindow)} tokens${contextBar}`);
			} else {
				lines.push(`▸ Context     unavailable`);
			}
			lines.push(`▸ Session     ↑${fmtTokens(totals.input)}  ↓${fmtTokens(totals.output)}  cache ${fmtTokens(totals.cacheRead + totals.cacheWrite)}  cost ${fmtMoney(totals.cost)}`);

			const provider = model?.provider?.toLowerCase();
			if (provider === "openai" || provider?.includes("openai")) {
				try {
					const codexUsage = await fetchCodexUsage();
					if (codexUsage) lines.push("", codexUsage);
					else lines.push("", "OpenAI/Codex limits: no ~/.codex ChatGPT auth found");
				} catch (err) {
					lines.push("", `OpenAI/Codex limits: failed (${err instanceof Error ? err.message : String(err)})`);
				}
			} else if (provider === "anthropic") {
				lines.push("", "Anthropic quota: no account endpoint configured; showing local/session usage only.");
			}

			const headers = formatProviderHeaders(latestProviderHeaders);
			if (headers) lines.push("", headers);
			lines.push("╰─");

			pi.sendMessage({
				customType: "smart-status",
				content: lines.join("\n"),
				display: true,
			});
		},
	});
}
