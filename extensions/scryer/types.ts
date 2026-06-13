export type RecorderState = {
	sessionKey: string;
	sessionName: string;
	cwd: string;
	cwdTag: string;
	currentDate?: string;
	ticketId?: string;
	ticketProjectId?: string;
	ticketProjectName?: string;
	ticketTitle?: string;
	lastSummaryAt?: number;
	lastSaveAt?: number;
	lastUpdateAt?: number;
	lastSaveReason?: string;
	lastSaveAttemptAt?: number;
	lastActivityAt?: number;
	lastPmPromptAt?: number;
	outputTokensSinceSummary: number;
	summary: string;
	finalized?: boolean;
	activeProjectId?: string;
	activeProjectName?: string;
	activeTaskId?: string;
	activeTaskTitle?: string;
	noProjectForSession?: boolean;
	noTicketForSession?: boolean;
};

export type ToolEvent = {
	name: string;
	input?: unknown;
	ok?: boolean;
	error?: string;
};
