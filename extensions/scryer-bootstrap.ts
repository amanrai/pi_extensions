import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const PM_URL = process.env.SCRYER_PM_URL ?? "http://127.0.0.1:43210";
const DAILIES_SLUG = process.env.SCRYER_DAILIES_SLUG ?? "dailies";

type Project = { id: string; name: string; slug: string; description_md?: string | null; relative_repo_path?: string | null; remote_repo_url?: string | null };
type Task = { id: string; project_id: string | null; title: string; status: string; description_md?: string | null; tags?: Array<{ name: string }> };
type Point = { title: string; evidence: string; recorded_state: string; deviation: string; confidence: "high" | "medium" | "low"; suggested_action: string; suggested_project?: string; suggested_ticket?: string };

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { cwd, timeout: 20_000 }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()));
	});
}

async function api(path: string, init?: RequestInit): Promise<any> {
	const res = await fetch(`${PM_URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
	const text = await res.text();
	if (!res.ok) throw new Error(`PM API ${res.status}: ${text}`);
	return text ? JSON.parse(text) : undefined;
}

async function ensureGitRepo(ctx: ExtensionContext): Promise<string | undefined> {
	try { return await exec("git", ["rev-parse", "--show-toplevel"], ctx.cwd); }
	catch {
		ctx.ui.notify("Not a git repo. Initialize/connect a remote first, then rerun this command.", "warning");
		return undefined;
	}
}

async function collectRepo(root: string) {
	const safe = async (args: string[]) => exec("git", args, root).catch((e) => `(unavailable: ${e.message})`);
	const files = (await safe(["ls-files"])).split("\n").filter(Boolean);
	const docFiles = files.filter((f) => /(^|\/)(README|TODO|AGENTS|CLAUDE|HANDOFF|CHANGELOG)|\.(md|mdx)$/i.test(f)).slice(0, 30);
	const docs: string[] = [];
	for (const file of docFiles.slice(0, 12)) {
		try { docs.push(`--- ${file}\n${(await readFile(join(root, file), "utf8")).slice(0, 3000)}`); } catch {}
	}
	return {
		root,
		name: basename(root),
		remote: await safe(["remote", "get-url", "origin"]),
		branch: await safe(["branch", "--show-current"]),
		status: await safe(["status", "--short"]),
		recentCommits: await safe(["log", "--oneline", "-12"]),
		branches: await safe(["branch", "--all", "--no-color"]),
		todos: await safe(["grep", "-nE", "TODO|FIXME|HACK|XXX"]),
		fileSample: files.slice(0, 220).join("\n"),
		docs: docs.join("\n\n").slice(0, 24000),
	};
}

async function collectPm() {
	const projects: Project[] = await api("/api/projects");
	const dailies = projects.find((p) => p.slug === DAILIES_SLUG || p.name.toLowerCase() === DAILIES_SLUG);
	const tasksByProject: Record<string, Task[]> = {};
	for (const p of projects) tasksByProject[p.id] = await api(`/api/tasks?project_id=${encodeURIComponent(p.id)}`);
	const dailiesTasks = dailies ? tasksByProject[dailies.id] ?? [] : [];
	return { projects, tasksByProject, dailies, dailiesTasks };
}

function pmDigest(pm: Awaited<ReturnType<typeof collectPm>>) {
	return pm.projects.map((p) => {
		const tasks = (pm.tasksByProject[p.id] ?? []).map((t) => `- ${t.title} [${t.status}] tags=${(t.tags ?? []).map((x) => x.name).join(",")}\n  ${String(t.description_md ?? "").slice(0, 900).replace(/\n/g, " ")}`).join("\n");
		return `## ${p.name} (${p.slug})\nrepo=${p.remote_repo_url ?? p.relative_repo_path ?? "none"}\n${String(p.description_md ?? "").slice(0, 500)}\n${tasks}`;
	}).join("\n\n").slice(0, 50000);
}

async function askModel(ctx: ExtensionContext, prompt: string): Promise<string> {
	if (!ctx.model) throw new Error("No active model");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
	const response = await complete(ctx.model, { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "medium" });
	return response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
}

function reportPrompt(repo: any, pm: any) {
	return `You are reconciling a code repo against a PM system called Scryer. Produce markdown with EXACTLY these headings:
# What the Code Shows
# Previously Held Off
# Important Decisions To Make RN
# Repo State

Under What the Code Shows, each bullet must include recorded state/deviation or unrecorded, and confidence high/medium/low. Do not include commit hashes.

<repo>${JSON.stringify(repo).slice(0, 60000)}</repo>
<pm>${pmDigest(pm)}</pm>`;
}

function jsonPrompt(repo: any, pm: any) {
	return `Return ONLY JSON: {"points":[...]}. Each point: title,evidence,recorded_state,deviation,confidence(high|medium|low),suggested_action,suggested_project,suggested_ticket. Compare repo reality to all Scryer projects/tickets and Dailies. Include missing repo links, missing tickets, stale tickets, and updates needed.
<repo>${JSON.stringify(repo).slice(0, 60000)}</repo>
<pm>${pmDigest(pm)}</pm>`;
}

function parseJsonPoints(text: string): Point[] {
	const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
	const parsed = JSON.parse(cleaned);
	return Array.isArray(parsed.points) ? parsed.points : [];
}

async function chooseProject(ctx: ExtensionContext, projects: Project[], suggested?: string): Promise<Project | undefined> {
	const labels = projects.map((p) => `${p.name} (${p.slug})${suggested && (p.name === suggested || p.slug === suggested) ? " ★" : ""}`);
	const choice = await ctx.ui.select("Project?", ["Skip", ...labels]);
	if (!choice || choice === "Skip") return undefined;
	return projects[labels.indexOf(choice)];
}

async function chooseTask(ctx: ExtensionContext, tasks: Task[], suggested?: string): Promise<Task | undefined> {
	const labels = tasks.map((t) => `${t.title} [${t.status}]${suggested && t.title.includes(suggested) ? " ★" : ""}`);
	const choice = await ctx.ui.select("Ticket?", ["Skip", ...labels]);
	if (!choice || choice === "Skip") return undefined;
	return tasks[labels.indexOf(choice)];
}

async function workType(projectId: string): Promise<string> {
	const types = await api(`/api/task-types?project_id=${encodeURIComponent(projectId)}`);
	return (types.find((t: any) => t.key === "work") ?? types[0]).id;
}

async function applyPoint(ctx: ExtensionContext, point: Point, repo: any, pm: Awaited<ReturnType<typeof collectPm>>) {
	const action = await ctx.ui.select(`Point: ${point.title}`, ["Skip", "Create ticket", "Update ticket description", "Add comment", "Link repo to project"]);
	if (!action || action === "Skip") return;
	const project = await chooseProject(ctx, pm.projects.filter((p) => p.slug !== DAILIES_SLUG), point.suggested_project);
	if (!project) return;
	if (action === "Link repo to project") {
		await api(`/api/projects/${project.id}/repo-link`, { method: "PUT", body: JSON.stringify({ remote_url: repo.remote }) });
		ctx.ui.notify(`Linked repo to ${project.name}`, "info");
		return;
	}
	let task: Task | undefined;
	if (action === "Create ticket") {
		const title = await ctx.ui.input("Ticket title", point.title);
		if (!title) return;
		task = await api("/api/tasks", { method: "POST", body: JSON.stringify({ title, project_id: project.id, task_type_id: await workType(project.id), status: "in_execution", description_md: `# ${title}\n\n${point.evidence}\n\n## Recorded state\n${point.recorded_state}\n\n## Deviation\n${point.deviation}\n\nConfidence: ${point.confidence}`, tag_names: [`cwd:${repo.root.replace(process.env.HOME ?? "", "~")}`], created_by_role: "pi", created_by_instance_key: "scryer-bootstrap" }) });
		ctx.ui.notify(`Created ${project.name}/${task!.title}`, "info");
		return;
	}
	task = await chooseTask(ctx, pm.tasksByProject[project.id] ?? [], point.suggested_ticket);
	if (!task) return;
	const body = `## Bootstrap reconciliation\n\n${point.evidence}\n\nRecorded: ${point.recorded_state}\n\nDeviation: ${point.deviation}\n\nConfidence: ${point.confidence}`;
	if (action === "Add comment") {
		await api("/api/comments", { method: "POST", body: JSON.stringify({ task_id: task.id, author_role: "pi", author_instance_key: "scryer-bootstrap", body_md: body, body_format: "markdown" }) });
		ctx.ui.notify(`Commented on ${project.name}/${task.title}`, "info");
	} else {
		await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ description_md: `${task.description_md ?? ""}\n\n${body}`, status: "in_execution" }) });
		await api("/api/comments", { method: "POST", body: JSON.stringify({ task_id: task.id, author_role: "pi", author_instance_key: "scryer-bootstrap", body_md: `Updated description from bootstrap reconciliation.`, body_format: "markdown" }) });
		ctx.ui.notify(`Updated ${project.name}/${task.title}`, "info");
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("where-are-we", {
		description: "Read-only repo vs Scryer PM briefing",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.setStatus("scryer-bootstrap", "collecting repo/PM state…");
				const root = await ensureGitRepo(ctx); if (!root) return;
				const repo = await collectRepo(root); const pm = await collectPm();
				ctx.ui.setStatus("scryer-bootstrap", "analyzing…");
				const report = await askModel(ctx, reportPrompt(repo, pm));
				ctx.ui.setWidget("scryer-bootstrap-report", report.split("\n"), { placement: "belowEditor" });
			} catch (err: any) { ctx.ui.notify(`where-are-we failed: ${err?.message ?? err}`, "error"); }
			finally { ctx.ui.setStatus("scryer-bootstrap", undefined); }
		},
	});

	pi.registerCommand("bootstrap-scryer", {
		description: "Interactively reconcile repo work with Scryer PM",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.setStatus("scryer-bootstrap", "collecting repo/PM state…");
				const root = await ensureGitRepo(ctx); if (!root) return;
				const repo = await collectRepo(root); const pm = await collectPm();
				ctx.ui.setStatus("scryer-bootstrap", "building reconciliation points…");
				const points = parseJsonPoints(await askModel(ctx, jsonPrompt(repo, pm)));
				for (const point of points) await applyPoint(ctx, point, repo, pm);
			} catch (err: any) { ctx.ui.notify(`bootstrap-scryer failed: ${err?.message ?? err}`, "error"); }
			finally { ctx.ui.setStatus("scryer-bootstrap", undefined); }
		},
	});
}
