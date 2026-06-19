import { join } from "node:path";
import { homedir } from "node:os";

export const PM_URL = process.env.SCRYER_PM_URL ?? "http://100.105.192.98:43210";
export const DAILIES_SLUG = process.env.SCRYER_DAILIES_SLUG ?? "dailies";
export const OUTPUT_TOKEN_THRESHOLD = Number(process.env.SCRYER_RECORDER_OUTPUT_TOKEN_THRESHOLD ?? 50_000);
export const IDLE_MS = Number(process.env.SCRYER_RECORDER_IDLE_MS ?? 10 * 60 * 1000);
export const NEW_DAILY_HOURS = Number(process.env.SCRYER_RECORDER_NEW_DAILY_HOURS ?? 3);
export const SAVE_COOLDOWN_MS = Number(process.env.SCRYER_RECORDER_SAVE_COOLDOWN_MS ?? 30 * 60 * 1000);

export const RECORDER_DIR = join(homedir(), ".pi", "agent", "scryer-recorder");
export const STATE_DIR = join(RECORDER_DIR, "state");
export const OUTBOX_DIR = join(RECORDER_DIR, "outbox");
export const SUMMARIES_DIR = join(RECORDER_DIR, "summaries");
export const TOUCHLOG_DIR = join(RECORDER_DIR, "touchlogs");
