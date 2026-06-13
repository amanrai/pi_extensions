import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";

function execGit(args: string[], cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 5_000 }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
	});
}

function normalizeRepoUrl(value?: string | null): string {
	return String(value ?? "")
		.trim()
		.replace(/^git@([^:]+):/, "https://$1/")
		.replace(/\.git$/, "")
		.replace(/\/$/, "")
		.toLowerCase();
}

export async function repoContext(ctx: ExtensionContext) {
	const cwd = ctx.cwd || process.cwd();
	const gitRoot = await execGit(["rev-parse", "--show-toplevel"], cwd);
	const root = gitRoot || cwd;
	const remote = gitRoot ? await execGit(["remote", "get-url", "origin"], root) : undefined;
	return { cwd, root, remote, rootName: basename(root) };
}

export function projectScore(project: any, repo: Awaited<ReturnType<typeof repoContext>>): number {
	let score = 0;
	const remote = normalizeRepoUrl(repo.remote);
	const projectRemote = normalizeRepoUrl(project.remote_repo_url);
	if (remote && projectRemote && remote === projectRemote) score += 100;
	const rel = String(project.relative_repo_path ?? "").replace(/^\/+|\/+$/g, "");
	if (rel && (repo.root.endsWith(`/${rel}`) || repo.cwd.endsWith(`/${rel}`))) score += 60;
	const name = String(project.name ?? "").toLowerCase();
	const slug = String(project.slug ?? "").toLowerCase();
	const rootName = repo.rootName.toLowerCase();
	if (rootName && (name === rootName || slug === rootName)) score += 25;
	if (rootName && (name.includes(rootName) || slug.includes(rootName) || rootName.includes(slug))) score += 10;
	return score;
}

export function projectLabel(project: any, score?: number): string {
	const repo = project.remote_repo_url || project.relative_repo_path;
	const suffix = score ? ` · match ${score}` : "";
	return `${project.name} (${project.slug})${repo ? ` · ${repo}` : ""}${suffix}`;
}
