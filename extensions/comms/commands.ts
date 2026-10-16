import { parse } from "shell-quote";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";

type Token = string | { op?: string; pattern?: string; comment?: string; stdin?: string };
const UNKNOWN = "\u0000";
const separators = new Set([";", "&&", "|", "|&"]);
const outputOperators = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const fileCommands = new Set(["touch", "mkdir", "cp", "mv", "rm", "ln", "truncate", "chmod", "chown"]);

function balancedQuotes(text: string) {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\" && quote !== "'") { i++; continue; }
    if (!quote && char === "#" && (i === 0 || /\s/.test(text[i - 1]))) break;
    if (quote === char) quote = "";
    else if (!quote && (char === "'" || char === '"')) quote = char;
  }
  return !quote && !/\\$/.test(text);
}

/** Parse simple command lines without executing or expanding shell code. */
function commandLines(source: string): Token[][] {
  const lines = source.split("\n");
  const result: Token[][] = [];
  for (let i = 0; i < lines.length; i++) {
    let header = lines[i];
    while (!balancedQuotes(header) && i + 1 < lines.length) header += `\n${lines[++i]}`;
    let tokens: Token[];
    try {
      tokens = parse(header, (name) => name === "HOME" ? homedir() : UNKNOWN) as Token[];
    } catch { continue; }
    // Consume heredoc bodies as data, never as additional shell commands.
    let complete = true;
    for (let j = 0; j < tokens.length; j++) {
      const token = tokens[j];
      if (typeof token === "string" || !["<<", "<<-"].includes(token.op ?? "")) continue;
      const delimiter = tokens[j + 1];
      if (typeof delimiter !== "string" || !delimiter || delimiter.includes(UNKNOWN)) { complete = false; break; }
      const body: string[] = [];
      let found = false;
      while (++i < lines.length) {
        const line = token.op === "<<-" ? lines[i].replace(/^\t+/, "") : lines[i];
        if (line === delimiter) { found = true; break; }
        body.push(line);
      }
      if (!found) { complete = false; break; }
      tokens.splice(j, 2, { stdin: body.join("\n") });
    }
    if (complete) result.push(tokens);
  }
  return result;
}

function pathFromWord(word: string, cwd: string): string | undefined {
  if (!word || word.includes(UNKNOWN) || /\$|`|[{}*?]/.test(word)) return undefined;
  if (/^\/dev\/(?:null|stdout|stderr|stdin|fd\/)/.test(word)) return undefined;
  return resolve(cwd, word === "~" ? homedir() : word.startsWith("~/") ? `${homedir()}/${word.slice(2)}` : word);
}

async function targetFolder(word: string, cwd: string) {
  const path = pathFromWord(word, cwd);
  if (!path) {
    // A glob's filename may be unknown while its containing folder is literal.
    return /[*?]/.test(word) ? pathFromWord(dirname(word), cwd) : undefined;
  }
  try { if ((await stat(path)).isDirectory()) return path; } catch { /* A deleted/new file still has a parent. */ }
  return dirname(path);
}

function positional(args: string[], valueFlags: string[] = []) {
  const result: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    if (options && args[i] === "--") { options = false; continue; }
    if (options && valueFlags.includes(args[i])) { i++; continue; }
    if (options && args[i].startsWith("-")) continue;
    result.push(args[i]);
  }
  return result;
}

function inplaceFiles(args: string[], perl: boolean) {
  const files: string[] = [];
  let expression = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-i" && args[i + 1] === "") { i++; continue; }
    if (["-e", "--expression", "-f", "--file"].includes(arg) || (perl && /^-[a-z]*e$/.test(arg))) {
      expression = true; i++; continue;
    }
    if (/^--(?:expression|file)=/.test(arg)) { expression = true; continue; }
    if (arg.startsWith("-")) continue;
    if (!expression) { expression = true; continue; }
    files.push(arg);
  }
  return files;
}

// Preserve offsets while hiding strings/comments, so printed examples are not writes.
function maskScript(text: string) {
  return text.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g,
    (match) => " ".repeat(match.length));
}

function firstLiteral(text: string): string | undefined {
  return /^\s*\(\s*(['"])([^'"\n\\]*)\1/.exec(text)?.[2];
}

function secondLiteral(text: string): string | undefined {
  return /^\s*\(\s*(['"])[^'"\n\\]*\1\s*,\s*(['"])([^'"\n\\]*)\2/.exec(text)?.[3];
}

function scriptWrites(code: string, python: boolean): { writes: boolean; paths: string[] } {
  const masked = maskScript(code);
  const paths: string[] = [];
  let writes = false;
  if (python) {
    for (const match of masked.matchAll(/\bopen\s*\(/g)) {
      const args = code.slice(match.index! + match[0].indexOf("("));
      const mode = /^\(\s*(?:['"][^'"\n]*['"]|[\w.]+)\s*,\s*(?:mode\s*=\s*)?(['"])([rwax][bt+]*?)\1/.exec(args)?.[2];
      if (mode && (/[wax]/.test(mode) || mode.includes("+"))) {
        writes = true;
        const path = firstLiteral(args);
        if (path) paths.push(path);
      }
    }
    if (/\.(?:write_text|write_bytes|touch|mkdir|unlink)\s*\(/.test(masked)) writes = true;
    for (const match of code.matchAll(/\bPath\s*\(\s*(['"])([^'"\n\\]+)\1\s*\)\s*\.(?:write_text|write_bytes|touch|mkdir|unlink)\s*\(/g)) {
      if (masked.slice(match.index!, match.index! + 4) === "Path") paths.push(match[2]);
    }
    for (const match of code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:pathlib\.)?Path\s*\(\s*(['"])([^'"\n\\]+)\2\s*\)/g)) {
      if (masked.slice(match.index!, match.index! + match[1].length) === match[1] &&
        new RegExp(`\\b${match[1]}\\s*\\.\\s*(?:write_text|write_bytes|touch|mkdir|unlink)\\s*\\(`).test(masked)) paths.push(match[3]);
    }
    for (const match of masked.matchAll(/\b(?:os\.(?:remove|unlink|mkdir|makedirs|rename|replace|chmod|chown)|shutil\.(?:copy|copy2|copyfile|move|rmtree))\s*\(/g)) {
      writes = true;
      const args = code.slice(match.index! + match[0].indexOf("("));
      const path = firstLiteral(args);
      if (path && !/^shutil\.copy/.test(match[0])) paths.push(path);
      if (/^(?:os\.(?:rename|replace)|shutil\.(?:copy|move))/.test(match[0])) {
        const destination = secondLiteral(args);
        if (destination) paths.push(destination);
      }
    }
  } else {
    for (const match of masked.matchAll(/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|copyFile(?:Sync)?|rename(?:Sync)?|unlink(?:Sync)?|mkdir(?:Sync)?|rm(?:Sync)?|truncate(?:Sync)?|chmod(?:Sync)?|chown(?:Sync)?)\s*\(/g)) {
      writes = true;
      const args = code.slice(match.index! + match[0].indexOf("("));
      const path = firstLiteral(args);
      if (path && !/^copyFile/.test(match[0])) paths.push(path);
      if (/^(?:copyFile|rename)/.test(match[0])) {
        const destination = secondLiteral(args);
        if (destination) paths.push(destination);
      }
    }
  }
  return { writes, paths };
}

async function scriptSource(args: string[], stdin: string, cwd: string, python: boolean) {
  const flag = args.findIndex((arg) => python ? arg === "-c" : ["-e", "--eval"].includes(arg));
  if (flag >= 0) return args[flag + 1] ?? "";
  if (!python) {
    const inline = args.find((arg) => arg.startsWith("--eval="));
    if (inline) return inline.slice(7);
  }
  if (stdin && (args.includes("-") || !positional(args).length)) return stdin;
  const file = positional(args)[0];
  const path = file && pathFromWord(file, cwd);
  if (!path) return "";
  try {
    if ((await stat(path)).size > 64 * 1024) return "";
    return await readFile(path, "utf8");
  } catch { return ""; }
}

function patchPaths(text: string, strip: number) {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const custom = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (custom) { paths.push(custom[1]); continue; }
    const unified = /^(?:\+\+\+|---) (\S+)/.exec(line)?.[1];
    if (unified && unified !== "/dev/null") paths.push(unified.split("/").slice(strip).join("/"));
  }
  return paths;
}

const execFileAsync = promisify(execFile);

export async function commitHead(folder: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: folder, timeout: 2000 });
    return stdout.trim();
  } catch { return undefined; }
}

export async function snapshotCommits(command: string, cwd: string): Promise<Map<string, string | undefined>> {
  const { commitFolders } = await commandAttribution(command, cwd);
  return new Map(await Promise.all(commitFolders.map(async (folder) => [folder, await commitHead(folder)] as const)));
}

export async function confirmedCommits(before: ReadonlyMap<string, string | undefined>): Promise<Set<string>> {
  const confirmed = new Set<string>();
  for (const [folder, previous] of before) {
    const current = await commitHead(folder);
    if (current && current !== previous) confirmed.add(folder);
  }
  return confirmed;
}

export type CommandAttribution = { commandFolders: string[]; fileFolders: string[]; commitFolders: string[] };

/** Initial command allowlist, not a general shell interpreter or filesystem audit. */
export async function commandAttribution(source: string, initialCwd: string): Promise<CommandAttribution> {
  const commandFolders = new Set<string>();
  const fileFolders = new Set<string>();
  const commitFolders = new Set<string>();
  let cwd = resolve(initialCwd);
  const lines = commandLines(source);
  // Unsupported control flow can skip later lines even when the overall tool succeeds.
  if (lines.some((tokens) => tokens.some((token, index) => {
    if (typeof token !== "string") return ["||", "&", "(", ")", "<(", ">("].includes(token.op ?? "");
    const previous = tokens[index - 1];
    const atStart = index === 0 || (typeof previous !== "string" && previous?.op && separators.has(previous.op));
    return atStart && ["if", "then", "else", "elif", "fi", "for", "while", "until", "case", "esac", "do", "done", "function", "{", "}"].includes(token);
  }))) return { commandFolders: [], fileFolders: [], commitFolders: [] };
  for (const tokens of lines) {
    const segments: { tokens: Token[]; separator?: string }[] = [];
    let segment: Token[] = [];
    for (const token of tokens) {
      if (typeof token !== "string" && token.op && separators.has(token.op)) {
        segments.push({ tokens: segment, separator: token.op }); segment = [];
      } else segment.push(token);
    }
    segments.push({ tokens: segment });
    for (const current of segments) {
      const words: string[] = [];
      const outputs: string[] = [];
      let stdin = "";
      let inputFile = "";
      let unsupported = false;
      for (let i = 0; i < current.tokens.length; i++) {
        const token = current.tokens[i];
        if (typeof token === "string") { words.push(token); continue; }
        if (token.comment !== undefined) break;
        if (token.op === "glob" && token.pattern) { words.push(token.pattern); continue; }
        if (token.stdin !== undefined) { stdin = token.stdin; continue; }
        if (outputOperators.has(token.op ?? "")) {
          const target = current.tokens[++i];
          if (typeof target === "string") outputs.push(target);
        } else if (["<", "<&", ">&", "<<<"].includes(token.op ?? "")) {
          const target = current.tokens[++i];
          if (token.op === "<" && typeof target === "string") inputFile = target;
        } else unsupported = true;
      }
      if (unsupported) continue;
      while (words[0] && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
      if (["command", "exec"].includes(words[0])) words.shift();
      if (words[0] === "env") {
        words.shift();
        while (words[0] && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
      }
      const executable = basename(words[0] ?? "");
      const args = words.slice(1);
      if (["if", "then", "else", "fi", "for", "while", "until", "case", "function", "{", "}"].includes(executable)) continue;
      if (executable === "cd") {
        const next = pathFromWord(args[0] ?? homedir(), cwd);
        if (next && !["|", "|&"].includes(current.separator ?? "")) {
          try { if ((await stat(next)).isDirectory()) cwd = next; } catch { /* Failed cd does not change cwd. */ }
        }
        continue;
      }
      let executionCwd = cwd;
      let writes = false;
      let commit = false;
      const targets: string[] = [];
      if (fileCommands.has(executable)) {
        writes = true;
        const valueFlags = executable === "touch" ? ["-r", "--reference", "-t", "-d", "--date", "--time"]
          : executable === "truncate" ? ["-r", "--reference", "-s", "--size"]
          : ["cp", "mv", "ln"].includes(executable) ? ["-t", "--target-directory"]
          : executable === "mkdir" ? ["-m", "--mode"] : ["--reference"];
        const operands = positional(args, valueFlags);
        if (["cp", "ln"].includes(executable)) {
          const explicit = args.findIndex((arg) => ["-t", "--target-directory"].includes(arg));
          const inline = args.find((arg) => arg.startsWith("--target-directory="))?.slice(19);
          targets.push(...(inline ? [inline] : explicit >= 0 ? [args[explicit + 1]] : executable === "ln" && operands.length === 1 ? [] : operands.slice(-1)));
        } else if (executable === "mv") {
          targets.push(...operands);
          const explicit = args.findIndex((arg) => ["-t", "--target-directory"].includes(arg));
          if (explicit >= 0) targets.push(args[explicit + 1]);
          const inline = args.find((arg) => arg.startsWith("--target-directory="))?.slice(19);
          if (inline) targets.push(inline);
        }
        else if (["chmod", "chown"].includes(executable)) targets.push(...operands.slice(args.some((arg) => arg.startsWith("--reference")) ? 0 : 1));
        else targets.push(...operands);
      } else if (executable === "tee") {
        const files = positional(args);
        targets.push(...files); writes ||= files.length > 0;
      } else if (["sed", "perl"].includes(executable) && args.some((arg) => arg.startsWith("--in-place") || (/^-[a-z]*i/.test(arg) && !arg.startsWith("--")))) {
        writes = true;
        targets.push(...inplaceFiles(args, executable === "perl"));
      } else if (["apply_patch", "patch"].includes(executable)) {
        writes = true;
        let patch = stdin || args.find((arg) => arg.includes("*** Begin Patch")) || "";
        const fileFlag = args.findIndex((arg) => ["-i", "--input"].includes(arg));
        const patchFile = inputFile || (fileFlag >= 0 ? args[fileFlag + 1] : "");
        if (!patch && patchFile) {
          const path = pathFromWord(patchFile, cwd);
          if (path) try { if ((await stat(path)).size <= 64 * 1024) patch = await readFile(path, "utf8"); } catch { /* Optional path detail. */ }
        }
        const stripFlag = args.find((arg) => /^-p\d+$/.test(arg));
        targets.push(...patchPaths(patch, executable === "apply_patch" ? 0 : Number(stripFlag?.slice(2) ?? 0)));
      } else if (/^(?:python(?:\d+(?:\.\d+)*)?|node|nodejs)$/.test(executable)) {
        const script = await scriptSource(args, stdin, cwd, executable.startsWith("python"));
        const detected = scriptWrites(script, executable.startsWith("python"));
        writes ||= detected.writes; targets.push(...detected.paths);
      } else if (executable === "git") {
        let index = 0;
        while (index < args.length && args[index].startsWith("-")) {
          if (args[index] === "-C") { executionCwd = pathFromWord(args[index + 1] ?? "", executionCwd) ?? executionCwd; index += 2; }
          else if (["-c", "--git-dir", "--work-tree"].includes(args[index])) index += 2;
          else index++;
        }
        commit = args[index] === "commit" && !args.includes("--dry-run");
        writes ||= commit;
      }
      if (args.some((arg) => ["--help", "--version"].includes(arg)) ||
        (executable === "patch" && args.some((arg) => ["--dry-run", "--check"].includes(arg)))) {
        writes = false;
        commit = false;
        targets.length = 0;
      }
      // Shell redirection happens in the shell's cwd, not a git -C directory.
      for (const target of outputs.filter((path) => !path.startsWith("/dev/"))) {
        commandFolders.add(cwd);
        const folder = await targetFolder(target, cwd);
        if (folder) fileFolders.add(folder);
      }
      if (!writes) continue;
      commandFolders.add(executionCwd);
      if (commit) commitFolders.add(executionCwd);
      let resolvedTarget = false;
      for (const target of targets) {
        const folder = await targetFolder(target, executionCwd);
        if (folder) { fileFolders.add(folder); resolvedTarget = true; }
      }
      if (!commit && !resolvedTarget) fileFolders.add(executionCwd);
    }
  }
  return {
    commandFolders: [...commandFolders].sort(),
    fileFolders: [...fileFolders].sort(),
    commitFolders: [...commitFolders].sort(),
  };
}

export async function commandTouchedFolders(source: string, initialCwd: string): Promise<string[]> {
  const attribution = await commandAttribution(source, initialCwd);
  return [...new Set([...attribution.commandFolders, ...attribution.fileFolders, ...attribution.commitFolders])].sort();
}
