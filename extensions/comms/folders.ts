import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { commandTouchedFolders } from "./commands.ts";

export const FOLDER_TOUCH = "scryer-folder-touch";
export const FOLDER_TOUCHES_SENT = "scryer-folder-touches-sent";

export type FolderTouch = {
  id: string;
  tool: string;
  summary: string;
  folders: string[];
  createdAt: string;
  codeChanged?: boolean;
};

export async function observeFolderTouch(
  tool: string,
  input: Record<string, unknown>,
  isError: boolean,
  cwd: string,
  codeChanged = false,
): Promise<FolderTouch | undefined> {
  if (isError) return undefined;
  let folders: string[] = [];
  let summary = "";
  if (["edit", "write"].includes(tool) && typeof input.path === "string") {
    const path = input.path.startsWith("~/") ? `${homedir()}/${input.path.slice(2)}` : input.path;
    folders = [dirname(resolve(cwd, path))];
    summary = `${tool}: ${input.path}`;
  } else if (tool === "bash" && typeof input.command === "string") {
    folders = await commandTouchedFolders(input.command, cwd);
    summary = input.command;
  }
  if (!folders.length) return undefined;
  return { id: randomUUID(), tool, summary: summary.slice(0, 800), folders, createdAt: new Date().toISOString(), codeChanged };
}

/** Branch-local custom entries survive reload/resume without replaying sent touches. */
export function pendingFolderTouches(branch: readonly any[]): FolderTouch[] {
  const pending = new Map<string, FolderTouch>();
  for (const entry of branch) {
    if (entry?.type !== "custom") continue;
    if (entry.customType === FOLDER_TOUCH) {
      const touch = entry.data;
      if (touch && typeof touch.id === "string" && typeof touch.summary === "string" &&
        Array.isArray(touch.folders) && touch.folders.every((path: unknown) => typeof path === "string" && isAbsolute(path))) {
        pending.set(touch.id, touch);
      }
    } else if (entry.customType === FOLDER_TOUCHES_SENT && Array.isArray(entry.data?.touchIds)) {
      for (const id of entry.data.touchIds) pending.delete(id);
    }
  }
  return [...pending.values()];
}

/** Never accept invented paths from the model; it may reference observed IDs only. */
export function selectUpdateFolders(touches: readonly FolderTouch[], ids: unknown, machineName: string) {
  const requested = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  const selected = touches.filter((touch) => requested.has(touch.id));
  return {
    touchIds: selected.map((touch) => touch.id),
    codeChanged: selected.some((touch) => touch.codeChanged === true),
    foldersTouched: [...new Set(selected.flatMap((touch) => touch.folders.map((folder) => `${machineName}:${folder}`)))].sort(),
  };
}
