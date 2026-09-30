/**
 * AGY Mode extension for pi
 *
 * Declares Antigravity-style (agy) tools and can replace pi's system prompt
 * with an Antigravity-style prompt (see agy-prompt.ts). Tool names/schemas
 * mirror the Antigravity CLI 1.2.14 capture in 20260930-215001_29e0f745.json.
 *
 * Tool mapping:
 *   view_file / run_command / write_to_file / replace_file_content / ask_question
 *       -> pi built-ins (read / bash / write / edit / dialogs)
 *   search_web -> web_search        (pi-web-access, when installed)
 *   read_url_content -> fetch_content (pi-web-access, when installed)
 *   send_message -> steer_subagent  (pi-subagents, when installed)
 *   manage_task -> native registry (tasks.ts, borrowed from pi-background-tasks)
 *       — adds 'send_input' (stdin) that bg_* tools do not expose
 *   schedule -> native timers + cron (schedule.ts)
 *   generate_image -> intentionally not provided
 *
 * Controlled with /agy-mode:
 *   /agy-mode             show current status
 *   /agy-mode always      force agy prompt + tools for every model
 *   /agy-mode gemini-only apply them only when the model id/name matches /gemini/i (default)
 *   /agy-mode off         never apply them
 *
 * The choice is persisted in the session (survives reload/resume). A global
 * default can be set with an "agyMode" key in settings.json.
 *
 * Install: copy this directory to ~/.pi/agent/extensions/agy-mode/
 * (or add via --extension ./agy-mode).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildAgySystemPrompt } from "./agy-prompt.ts";
import { AgyTaskRegistry, DEFAULT_LOG_BYTES, taskDisplayName } from "./tasks.ts";
import { AgyScheduler } from "./schedule.ts";
import {
	activeAgyToolNames,
	allAgyToolNames,
	ensureCapabilityWrappers,
	hiddenOriginals,
	probeCapabilities,
	type AgyCapabilities,
} from "./wrappers.ts";

const GEMINI_RE = /gemini/i;

type AgyMode = "always" | "gemini-only" | "off";
const AGY_MODES: AgyMode[] = ["always", "gemini-only", "off"];
const MODE_ALIASES: Record<string, AgyMode> = {
	always: "always",
	on: "always",
	force: "always",
	"gemini-only": "gemini-only",
	gemini: "gemini-only",
	auto: "gemini-only",
	default: "gemini-only",
	off: "off",
	disabled: "off",
	never: "off",
};
const MODE_ENTRY_TYPE = "agy-mode";

function parseAgyMode(input: string): AgyMode | undefined {
	return MODE_ALIASES[input.trim().toLowerCase()];
}

/** Durable, cross-session persistence for /agy-mode (last explicit choice). */
const STATE_FILE = join(getAgentDir(), "agy-mode.json");

function readGlobalMode(): AgyMode | undefined {
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { mode?: unknown };
		if (typeof parsed.mode === "string" && AGY_MODES.includes(parsed.mode as AgyMode)) {
			return parsed.mode as AgyMode;
		}
	} catch {
		// missing or unreadable file — no persisted choice
	}
	return undefined;
}

function writeGlobalMode(mode: AgyMode): void {
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify({ mode }, null, 2)}\n`, "utf-8");
	} catch {
		// read-only agent dir — session persistence still applies
	}
}

function quoteShell(path: string): string {
	return `'${path.replaceAll("'", `'\\''`)}'`;
}

export default function agyModeExtension(pi: ExtensionAPI) {
	/** Active tool set observed before agy mode took over, restored when leaving. */
	let baseTools: string[] | null = null;
	/** Current mode; session-persisted, defaults to gemini-only (or settings.json "agyMode"). */
	let mode: AgyMode = "gemini-only";
	/** Session-scoped services (created in session_start, disposed in session_shutdown). */
	let taskRegistry: AgyTaskRegistry | null = null;
	let scheduler: AgyScheduler | null = null;
	let caps: AgyCapabilities = { webSearch: false, fetchContent: false, steerSubagent: false };

	const isAgyTarget = (model: ExtensionContext["model"]): boolean => {
		if (mode === "always") return true;
		if (mode === "off") return false;
		return !!model && (GEMINI_RE.test(model.id) || GEMINI_RE.test(model.name));
	};

	const readInitialMode = (): AgyMode => {
		try {
			const fromSettings = (pi.getSettings() as Record<string, unknown>)["agyMode"];
			if (typeof fromSettings === "string") {
				const parsed = parseAgyMode(fromSettings);
				if (parsed) return parsed;
			}
		} catch {
			// settings unavailable — keep default
		}
		return "gemini-only";
	};

	const restorePersistedMode = (ctx: ExtensionContext): void => {
		mode = readGlobalMode() ?? readInitialMode();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE) {
				const saved = (entry.data as { mode?: unknown } | undefined)?.mode;
				if (typeof saved === "string" && AGY_MODES.includes(saved as AgyMode)) {
					mode = saved as AgyMode;
				}
			}
		}
	};

	const applyToolMode = (model: ExtensionContext["model"]) => {
		const agy = isAgyTarget(model);
		const current = pi.getActiveTools();
		if (baseTools === null) {
			// First application: snapshot whatever the session normally exposes.
			baseTools = current;
		}
		if (agy) {
			const hidden = new Set([...hiddenOriginals(caps), ...allAgyToolNames()]);
			const keep = current.filter((n) => !hidden.has(n));
			pi.setActiveTools([...keep, ...activeAgyToolNames(caps)]);
		} else if (baseTools) {
			const agyNames = new Set(allAgyToolNames());
			pi.setActiveTools(baseTools.filter((n) => !agyNames.has(n)));
		}
	};

	/** Re-probe other extensions' tools and register agy wrappers for new ones. */
	const refreshCapabilities = (): void => {
		caps = probeCapabilities(pi);
		ensureCapabilityWrappers(pi, caps);
	};

	// ------------------------------------------------------------------
	// Native services: background tasks + schedule
	// ------------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		baseTools = null;
		restorePersistedMode(ctx);

		const notify = async (customType: string, content: string, senderId: string) => {
			// Early-terminate armed timers per TimerCondition (agy semantics).
			scheduler?.cancelOnNotification(senderId);
			try {
				await pi.sendMessage({ customType, content, display: true }, { deliverAs: "followUp", triggerTurn: true });
			} catch {
				// session may be shutting down; nothing sensible to do
			}
		};

		taskRegistry = new AgyTaskRegistry({
			outputDir: join(ctx.cwd, ".pi", "agy-tasks"),
			sendCompletionNotification: (message, options) => {
				void notify(message.customType, message.content, message.details.id);
			},
			onTerminal: (task) => {
				scheduler?.cancelOnNotification(task.id);
			},
		});
		scheduler = new AgyScheduler((content, senderId) => {
			void notify("agy-schedule-notification", content, senderId);
		});

		refreshCapabilities();
		applyToolMode(ctx.model);
	});

	pi.on("session_shutdown", () => {
		void taskRegistry?.disposeAll();
		scheduler?.cancelAll();
		taskRegistry = null;
		scheduler = null;
	});

	pi.on("model_select", (event) => {
		refreshCapabilities();
		applyToolMode(event.model);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		refreshCapabilities(); // other extensions may have registered tools since start
		applyToolMode(ctx.model);
		if (!isAgyTarget(ctx.model)) {
			return undefined;
		}
		return { systemPrompt: buildAgySystemPrompt(ctx, pi) };
	});

	// ------------------------------------------------------------------
	// Wrapper tools (agy name -> pi built-in)
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "view_file",
		label: "view_file",
		description:
			"View the contents of a file from the local filesystem. Supports text files and images.\n" +
			"- Lines are 1-indexed; at most 800 lines are shown at a time.\n" +
			"- Omit StartLine/EndLine to view the beginning of the file.\n" +
			"- Set StartLine to view a specific range (with optional EndLine, inclusive).\n" +
			"- Content is byte-limited; if truncated, call again with StartLine to continue.",
		parameters: Type.Object({
			AbsolutePath: Type.String({ description: "Path to file to view. Must be an absolute path." }),
			StartLine: Type.Optional(Type.Number({ description: "Optional. Start line to view, 1-indexed." })),
			EndLine: Type.Optional(
				Type.Number({ description: "Optional. End line to view, 1-indexed, inclusive; must be >= StartLine." }),
			),
			ContentOffset: Type.Optional(
				Type.Number({ description: "Accepted for compatibility; ignored. Re-call with StartLine to page through output." }),
			),
			toolAction: Type.Optional(Type.String({ description: "Brief 2-5 word -ing phrase describing the action." })),
			toolSummary: Type.Optional(Type.String({ description: "Brief 2-5 word noun phrase describing the task." })),
		}),
		async execute(_id, params, signal, onUpdate, toolCtx) {
			const start = params.StartLine !== undefined ? Math.max(1, Math.floor(params.StartLine)) : undefined;
			const end = params.EndLine !== undefined ? Math.max(1, Math.floor(params.EndLine)) : undefined;
			let args: Record<string, unknown>;
			if (start !== undefined && end !== undefined) {
				args = { path: params.AbsolutePath, offset: start, limit: Math.max(1, end - start + 1) };
			} else if (start !== undefined) {
				args = { path: params.AbsolutePath, offset: start };
			} else if (end !== undefined) {
				args = { path: params.AbsolutePath, offset: 1, limit: end };
			} else {
				args = { path: params.AbsolutePath };
			}
			const outcome = await toolCtx.executeTool("read", args, { signal, onUpdate });
			if (outcome.isError) throw new Error(textOf(outcome.result.content) || "read failed");
			return outcome.result;
		},
	});

	pi.registerTool({
		name: "run_command",
		label: "run_command",
		description:
			"Execute a shell command and return its combined stdout/stderr. Use it for searching (grep, rg, find), listing, git, builds, and tests.\n" +
			"- Runs synchronously; the call returns when the command exits.\n" +
			"- Set IsDaemon=true for servers/watchers: the command becomes a managed background task " +
			"(manage with manage_task; you are notified automatically when it exits).\n" +
			"- Cwd selects the working directory for the command.",
		parameters: Type.Object({
			CommandLine: Type.String({ description: "The exact command line string to execute." }),
			Cwd: Type.Optional(Type.String({ description: "Working directory for the command. Defaults to the session cwd." })),
			IsDaemon: Type.Optional(
				Type.Boolean({
					description:
						"True for long-running processes (dev servers, watchers): started as a managed background task; the task id and log path are returned.",
				}),
			),
			WaitMsBeforeAsync: Type.Optional(
				Type.Number({ description: "Accepted for compatibility; ignored (commands run to completion unless IsDaemon)." }),
			),
			toolAction: Type.Optional(Type.String({ description: "Brief 2-5 word -ing phrase describing the action." })),
			toolSummary: Type.Optional(Type.String({ description: "Brief 2-5 word noun phrase describing the task." })),
		}),
		async execute(_id, params, signal, onUpdate, toolCtx) {
			let command = params.CommandLine;
			const cwd = params.Cwd?.trim() || toolCtx.cwd;
			if (params.Cwd?.trim() && params.Cwd.trim() !== toolCtx.cwd) {
				command = `cd ${quoteShell(params.Cwd.trim())} && ${command}`;
			}
			if (params.IsDaemon) {
				if (!taskRegistry) throw new Error("Background tasks are unavailable before session start.");
				const task = await taskRegistry.start(command, cwd);
				return {
					content: [
						{
							type: "text",
							text:
								`Started background task ${task.id} (${task.name}).\n` +
								`Output log: ${task.outputPath}\n` +
								`You will be notified automatically when it exits. Use manage_task to list, inspect, kill, or send input to it. Do not poll; end your turn or continue other work.`,
						},
					],
					details: task,
				};
			}
			const outcome = await toolCtx.executeTool("bash", { command }, { signal, onUpdate });
			if (outcome.isError) throw new Error(textOf(outcome.result.content) || "bash failed");
			return outcome.result;
		},
	});

	pi.registerTool({
		name: "write_to_file",
		label: "write_to_file",
		description:
			"Write code/content to a file on the filesystem. Creates parent directories as needed.\n" +
			"- Fails if the file already exists unless Overwrite=true (full replacement) or Append=true.\n" +
			"- Prefer replace_file_content for targeted edits to existing files.",
		parameters: Type.Object({
			TargetFile: Type.String({ description: "The target file to write. Must be an absolute path." }),
			CodeContent: Type.String({ description: "The contents to write to the file." }),
			Overwrite: Type.Optional(
				Type.Boolean({ description: "Set true to replace an existing file's entire contents. Required when it exists." }),
			),
			Append: Type.Optional(
				Type.Boolean({ description: "Set true to append CodeContent to the end of the file (creates it if missing)." }),
			),
			Description: Type.Optional(Type.String({ description: "Brief user-facing explanation of the change." })),
			ArtifactMetadata: Type.Optional(Type.String({ description: "Accepted for compatibility; ignored." })),
			toolAction: Type.Optional(Type.String({ description: "Brief 2-5 word -ing phrase describing the action." })),
			toolSummary: Type.Optional(Type.String({ description: "Brief 2-5 word noun phrase describing the task." })),
		}),
		async execute(_id, params, signal, onUpdate, toolCtx) {
			const { access, appendFile } = await import("node:fs/promises");
			if (params.Append) {
				if (params.Overwrite) {
					throw new Error("Append=true cannot be combined with Overwrite=true.");
				}
				await appendFile(params.TargetFile, params.CodeContent, "utf-8");
				return {
					content: [{ type: "text", text: `Appended ${params.CodeContent.length} bytes to ${params.TargetFile}` }],
					details: undefined,
				};
			}
			if (!params.Overwrite) {
				try {
					await access(params.TargetFile);
					throw new Error(
						`${params.TargetFile} already exists. Set Overwrite=true to replace it, Append=true to append, or use replace_file_content for targeted edits.`,
					);
				} catch (e: any) {
					if (e?.code !== "ENOENT") throw e;
				}
			}
			const outcome = await toolCtx.executeTool("write", { path: params.TargetFile, content: params.CodeContent }, { signal, onUpdate });
			if (outcome.isError) throw new Error(textOf(outcome.result.content) || "write failed");
			return outcome.result;
		},
	});

	pi.registerTool({
		name: "replace_file_content",
		label: "replace_file_content",
		description:
			"Replace an exact string in an existing file.\n" +
			"- TargetContent must match the file EXACTLY (whitespace and indentation included) and be unique.\n" +
			"- If the match is not unique, include more surrounding lines until it is.\n" +
			"- StartLine/EndLine are accepted to document the expected location but matching is file-wide.",
		parameters: Type.Object({
			TargetFile: Type.String({ description: "The target file to modify. Must be an absolute path." }),
			TargetContent: Type.String({ description: "The exact character sequence to replace, including leading whitespace." }),
			ReplacementContent: Type.String({ description: "The content to replace the target with (empty string to delete)." }),
			AllowMultiple: Type.Optional(
				Type.Boolean({
					description: "Accepted; only the single unique match is replaced. Make TargetContent unique instead.",
				}),
			),
			StartLine: Type.Optional(Type.Number({ description: "Expected start of the match (1-indexed, advisory only)." })),
			EndLine: Type.Optional(Type.Number({ description: "Expected end of the match (1-indexed, advisory only)." })),
			Instruction: Type.Optional(Type.String({ description: "Short description of the change." })),
			Description: Type.Optional(Type.String({ description: "Brief user-facing explanation of the change." })),
			TargetLintErrorIds: Type.Optional(Type.Array(Type.String(), { description: "Accepted for compatibility; ignored." })),
			toolAction: Type.Optional(Type.String({ description: "Brief 2-5 word -ing phrase describing the action." })),
			toolSummary: Type.Optional(Type.String({ description: "Brief 2-5 word noun phrase describing the task." })),
		}),
		async execute(_id, params, signal, onUpdate, toolCtx) {
			const outcome = await toolCtx.executeTool(
				"edit",
				{ path: params.TargetFile, edits: [{ oldText: params.TargetContent, newText: params.ReplacementContent }] },
				{ signal, onUpdate },
			);
			if (outcome.isError) throw new Error(textOf(outcome.result.content) || "edit failed");
			return outcome.result;
		},
	});

	pi.registerTool({
		name: "ask_question",
		label: "ask_question",
		description:
			"Ask the user a clarifying question with selectable options. Use when intent is ambiguous and the choice is genuinely the user's to make.\n" +
			"Each question has optional options (2+); without options the user types a free-form answer.",
		parameters: Type.Object({
			questions: Type.Optional(
				Type.Array(
					Type.Object({
						question: Type.String({ description: "The question to ask the user." }),
						options: Type.Optional(Type.Array(Type.String(), { description: "At least 2 answer options." })),
						is_multi_select: Type.Optional(Type.Boolean({ description: "Accepted; single-select only." })),
					}),
					{ description: "The list of questions to ask." },
				),
			),
			toolAction: Type.Optional(Type.String({ description: "Brief 2-5 word -ing phrase describing the action." })),
			toolSummary: Type.Optional(Type.String({ description: "Brief 2-5 word noun phrase describing the task." })),
		}),
		async execute(_id, params, _signal, _onUpdate, toolCtx) {
			const questions = params.questions ?? [];
			if (!toolCtx.hasUI) {
				return {
					content: [
						{ type: "text", text: "No interactive UI available. State your assumptions and proceed with the most reasonable option." },
					],
					details: undefined,
				};
			}
			const lines: string[] = [];
			for (const [i, q] of questions.entries()) {
				const title = q.question || `Question ${i + 1}`;
				let answer: string | undefined;
				if (q.options && q.options.length >= 2) {
					answer = await toolCtx.ui.select(title, q.options);
				} else {
					answer = await toolCtx.ui.input(title);
				}
				lines.push(`Q: ${title}\nA: ${answer ?? "(skipped)"}`);
			}
			if (lines.length === 0) {
				const answer = await toolCtx.ui.input("Your question for the user");
				lines.push(`A: ${answer ?? "(no answer)"}`);
			}
			return { content: [{ type: "text", text: lines.join("\n\n") }], details: { answers: lines.length } };
		},
	});

	pi.registerTool({
		name: "manage_task",
		label: "manage_task",
		description:
			"Manage background tasks. Use this tool to list running tasks or interact with tasks that were sent to the background (started via run_command with IsDaemon=true).\n\n" +
			"Actions:\n" +
			"- 'list': List all currently running background tasks\n" +
			"- 'status': Check the task's current status, recent output, and log file location\n" +
			"- 'kill': Cancel the task's execution\n" +
			"- 'send_input': Send input to a running task's stdin\n\n" +
			"When mentioning tasks to the user, avoid using full task IDs and start timestamps; keep them human-readable.",
		parameters: Type.Object({
			Action: Type.String({
				description: "The action to perform: 'list' (list all running tasks), 'kill' (cancel the task), 'status' (check the task status and log URI), 'send_input' (send input to a running task).",
			}),
			TaskId: Type.Optional(Type.String({ description: "The task ID to manage. Required when Action is 'kill', 'status', or 'send_input'." })),
			Input: Type.Optional(Type.String({ description: "The input to send to the task. Required when Action is 'send_input'." })),
			toolAction: Type.Optional(Type.String({ description: "Brief 2-5 word -ing phrase describing the action." })),
			toolSummary: Type.Optional(Type.String({ description: "Brief 2-5 word noun phrase describing the task." })),
		}),
		async execute(_id, params): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
			if (!taskRegistry) throw new Error("Background tasks are unavailable before session start.");
			const taskList = taskRegistry.list();
			switch (params.Action) {
				case "list": {
					if (taskList.length === 0) return { content: [{ type: "text", text: "No background tasks." }], details: { count: 0 } };
					const lines = taskList.map((task) => {
						const age = formatDuration(Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt));
						return `${task.id} ${task.status}${task.exitCode !== null ? ` (exit ${task.exitCode})` : ""} ${age} — ${taskDisplayName(task.command, task.name)}\n    output: ${task.outputPath}`;
					});
					return { content: [{ type: "text", text: lines.join("\n") }], details: { count: taskList.length } };
				}
				case "status": {
					if (!params.TaskId) throw new Error("TaskId is required for Action='status'.");
					const task = taskRegistry.get(params.TaskId);
					if (!task) throw new Error(`Unknown background task ID: ${params.TaskId}`);
					const logs = await taskRegistry.logs(task.id, DEFAULT_LOG_BYTES, true);
					const meta = `${task.id} ${task.status}${task.exitCode !== null ? ` (exit ${task.exitCode})` : ""} — ${task.name}\nCommand: ${task.command}\nLog: ${task.outputPath}\n\nRecent output:\n`;
					return { content: [{ type: "text", text: meta + logs }], details: task };
				}
				case "kill": {
					if (!params.TaskId) throw new Error("TaskId is required for Action='kill'.");
					const message = await taskRegistry.stop(params.TaskId);
					return { content: [{ type: "text", text: message }], details: undefined };
				}
				case "send_input": {
					if (!params.TaskId) throw new Error("TaskId is required for Action='send_input'.");
					if (params.Input === undefined) throw new Error("Input is required for Action='send_input'.");
					return { content: [{ type: "text", text: taskRegistry.sendInput(params.TaskId, params.Input) }], details: undefined };
				}
				default:
					throw new Error(`Unknown Action "${params.Action}". Use 'list', 'status', 'kill', or 'send_input'.`);
			}
		},
	});

	pi.registerTool({
		name: "schedule",
		label: "schedule",
		description:
			"Schedule a one-shot timer or a recurring cron job that sends notifications in the background.\n\n" +
			"**NOTE**: This tool call returns immediately and does not pause execution. To wait for the timer to fire, stop calling tools to end your turn.\n\n" +
			"Modes:\n" +
			"1. **One-shot timer**: DurationSeconds + Prompt. TimerCondition controls early termination: 'never' (default), 'any' (cancels if any notification arrives first), or a specific sender id (e.g. a background task id like 'task-1').\n" +
			"2. **Recurring cron**: CronExpression (5 fields, e.g. '*/5 * * * *') + Prompt. Optionally MaxIterations to limit fires. The cron keeps firing until the session ends or MaxIterations is reached.\n\n" +
			"A task that is sure to terminate needs no timer: end your turn instead.",
		parameters: Type.Object({
			DurationSeconds: Type.Optional(
				Type.Number({ description: "The number of seconds to wait. Use for one-shot timers. Mutually exclusive with CronExpression." }),
			),
			CronExpression: Type.Optional(
				Type.String({
					description:
						"A standard cron expression (5 fields: minute hour day-of-month month day-of-week). Use for recurring schedules. Mutually exclusive with DurationSeconds. Example: '*/5 * * * *'.",
				}),
			),
			Prompt: Type.String({ description: "The message content to include in the notification when the timer fires or cron triggers." }),
			TimerCondition: Type.Optional(
				Type.String({
					description: "Optional. Early termination for one-shot timers: 'never' (default), 'any', or a sender id (e.g. 'task-1'). Only with DurationSeconds.",
				}),
			),
			MaxIterations: Type.Optional(
				Type.Number({ description: "Optional. Maximum number of cron fires before stopping. Only with CronExpression. Defaults to unlimited." }),
			),
			IsDaemon: Type.Optional(
				Type.Boolean({ description: "Accepted for compatibility; schedules are session-scoped either way." }),
			),
			toolAction: Type.Optional(Type.String({ description: "Brief 2-5 word -ing phrase describing the action." })),
			toolSummary: Type.Optional(Type.String({ description: "Brief 2-5 word noun phrase describing the task." })),
		}),
		async execute(_id, params) {
			if (!scheduler) throw new Error("Scheduler is unavailable before session start.");
			if (params.CronExpression !== undefined && params.DurationSeconds !== undefined) {
				throw new Error("DurationSeconds and CronExpression are mutually exclusive.");
			}
			if (params.CronExpression !== undefined) {
				const info = scheduler.setCron(params.CronExpression, params.Prompt, params.MaxIterations);
				return {
					content: [
						{
							type: "text",
							text: `Scheduled recurring cron ${info.id} (${info.cronExpression}). You will receive a <scheduled-notification> each time it fires. End your turn to wait.`,
						},
					],
					details: info,
				};
			}
			if (params.DurationSeconds !== undefined) {
				const info = scheduler.setTimer(params.DurationSeconds, params.Prompt, params.TimerCondition ?? "never");
				return {
					content: [
						{
							type: "text",
							text: `Scheduled one-shot timer ${info.id} for ${params.DurationSeconds}s${info.condition && info.condition !== "never" ? ` (early-terminates on: ${info.condition})` : ""}. You will receive a <scheduled-notification> when it fires${info.condition && info.condition !== "never" ? " — or earlier if the condition is met" : ""}. End your turn to wait.`,
						},
					],
					details: info,
				};
			}
			throw new Error("Provide either DurationSeconds (one-shot timer) or CronExpression (recurring).");
		},
	});

	// ------------------------------------------------------------------
	// /agy-mode command
	// ------------------------------------------------------------------

	pi.registerCommand("agy-mode", {
		description: "Show status or set agy mode: /agy-mode always | gemini-only | off",
		handler: async (args, ctx) => {
			const statusLine = () => {
				const model = ctx.model ? `${ctx.model.name} (${ctx.model.id})` : "none";
				const active = isAgyTarget(ctx.model);
				const mapped = caps.webSearch ? "web_search ✓" : "web_search ✗";
				const fetched = caps.fetchContent ? "fetch_content ✓" : "fetch_content ✗";
				const steer = caps.steerSubagent ? "steer_subagent ✓" : "steer_subagent ✗";
				return (
					`agy-mode: ${mode} (persisted) — ${active ? "ACTIVE" : "inactive"} for ${model}\n` +
					`mapped extensions: ${mapped}, ${fetched}, ${steer}\n` +
					`active tools: ${pi.getActiveTools().join(", ")}`
				);
			};

			const requested = args.trim();
			if (!requested) {
				ctx.ui.notify(statusLine(), "info");
				return;
			}

			const parsed = parseAgyMode(requested);
			if (!parsed) {
				ctx.ui.notify(`Unknown mode "${requested}". Usage: /agy-mode always | gemini-only | off`, "warning");
				return;
			}

			mode = parsed;
			writeGlobalMode(parsed);
			pi.appendEntry(MODE_ENTRY_TYPE, { mode: parsed });
			refreshCapabilities();
			applyToolMode(ctx.model);
			ctx.ui.notify(statusLine(), "info");
		},
	});
}

function textOf(content: unknown): string {
	const arr = Array.isArray(content) ? content : [];
	return arr
		.map((c: any) => (c && typeof c === "object" && "text" in c ? String(c.text) : ""))
		.join("\n");
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.floor(ms)}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m${remSeconds > 0 ? `${remSeconds}s` : ""}`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`;
}
