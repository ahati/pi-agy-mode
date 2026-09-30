/**
 * Session-scoped background task registry for agy-mode.
 *
 * Patterns and helpers borrowed from pi-background-tasks (ISC License,
 * https://github.com/ismailsaleekh/pi-background-tasks) — see the per-section
 * notes below. Adapted/simplified for agy-mode: no telemetry, attested runs,
 * reload handoff, or durable-fs; adds stdin input (agy manage_task
 * 'send_input') and completion hooks that feed schedule TimerConditions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

// --- borrowed from pi-background-tasks core/registry.js + extension.js ----
const KILL_GRACE_MS = 3_000; // their KILL_GRACE_MS
const MAX_RECENT_TASKS = 100; // their MAX_RECENT_TASKS
export const DEFAULT_LOG_BYTES = 50 * 1024; // their DEFAULT/MAX_LOG_BYTES (model-visible read cap)
export const MAX_LOG_BYTES = 50 * 1024;
// --------------------------------------------------------------------------

export type AgyTaskStatus = "running" | "completed" | "failed" | "killed";

export interface AgyTaskSnapshot {
	id: string;
	name: string;
	command: string;
	cwd: string;
	status: AgyTaskStatus;
	exitCode: number | null;
	signal: string | null;
	pid: number | null;
	startedAt: number;
	endedAt: number | null;
	outputPath: string;
}

interface InternalTask extends AgyTaskSnapshot {
	child: ChildProcess | null;
	groupId: number | null; // POSIX process group (borrowed: detached group ownership)
	killSignalSent: boolean;
	killEscalationTimer: ReturnType<typeof setTimeout> | null;
	killStartedAt: number | null;
	notified: boolean;
	finalized: boolean;
}

export interface AgyTaskRegistryOptions {
	/** Directory for task output files (agy-mode uses <cwd>/.pi/agy-tasks). */
	outputDir: string;
	/**
	 * Completion delivery — borrowed from pi-background-tasks' sendCompletionNotification:
	 * pi.sendMessage(...) with { deliverAs: "followUp", triggerTurn }.
	 */
	sendCompletionNotification: (
		message: { customType: string; content: string; display: boolean; details: AgyTaskSnapshot },
		options: { deliverAs: "followUp"; triggerTurn: boolean },
	) => void;
	/** Extra hook (agy-mode): called on terminal state with the task id as senderId. */
	onTerminal?: (task: AgyTaskSnapshot) => void;
}

export class AgyTaskRegistry {
	private tasks = new Map<string, InternalTask>();
	private counter = 0;
	private shuttingDown = false;

	private opts: AgyTaskRegistryOptions;

	constructor(opts: AgyTaskRegistryOptions) {
		this.opts = opts;
	}

	/** Start a command in the background; resolves once the process spawns. */
	async start(command: string, cwd: string, name?: string): Promise<AgyTaskSnapshot> {
		if (this.shuttingDown) throw new Error("Task registry is shutting down");
		const id = `task-${++this.counter}`;
		const outputPath = join(this.opts.outputDir, `${id}.log`);
		await mkdir(dirname(outputPath), { recursive: true });

		// Borrowed: detached POSIX process group so kills take the whole tree.
		const child = spawn("bash", ["-c", command], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const groupId = process.platform !== "win32" && child.pid ? -child.pid : null;

		const task: InternalTask = {
			id,
			name: taskDisplayName(command, name),
			command,
			cwd,
			status: "running",
			exitCode: null,
			signal: null,
			pid: child.pid ?? null,
			startedAt: Date.now(),
			endedAt: null,
			outputPath,
			child,
			groupId,
			killSignalSent: false,
			killEscalationTimer: null,
			killStartedAt: null,
			notified: false,
			finalized: false,
		};
		this.tasks.set(id, task);

		// Borrowed: merged stdout/stderr into the output file (their appendChildOutput
		// writes both sources to one stream).
		const header = `$ ${command}\n[cwd] ${cwd}\n[task] ${id} (${task.name})\n\n`;
		await mkdir(dirname(outputPath), { recursive: true });
		const { appendFile } = await import("node:fs/promises");
		await appendFile(outputPath, header).catch(() => {});
		child.stdout?.on("data", (chunk: Buffer) => void appendFile(outputPath, chunk).catch(() => {}));
		child.stderr?.on("data", (chunk: Buffer) => void appendFile(outputPath, chunk).catch(() => {}));
		child.on("error", (err: Error) => {
			void appendFile(outputPath, `\n[spawn error] ${err.message}\n`).catch(() => {});
			this.finalize(task, "failed", null, null);
		});
		child.on("close", (code, signal) => {
			if (task.finalized) return;
			this.finalize(task, code === 0 ? "completed" : task.killSignalSent ? "killed" : "failed", code, signal);
		});

		this.pruneOldTasks();
		return this.snapshot(task);
	}

	// Borrowed from pi-background-tasks resolveTask: exact then unique-prefix match.
	// Extension: bare digits ("2") resolve as task ids ("task-2") for convenience.
	resolveTask(idOrPrefix: string): InternalTask {
		let id = idOrPrefix.trim();
		if (!id) throw new Error("Task ID is required");
		if (/^\d+$/.test(id)) id = `task-${id}`;
		const exact = this.tasks.get(id);
		if (exact) return exact;
		const matches = [...this.tasks.values()].filter((task) => task.id.startsWith(id));
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) {
			throw new Error(`Ambiguous task ID prefix "${id}": ${matches.map((task) => task.id).join(", ")}`);
		}
		throw new Error(`Unknown background task ID: ${id}`);
	}

	list(): AgyTaskSnapshot[] {
		return [...this.tasks.values()].map((task) => this.snapshot(task));
	}

	/** Look up a task snapshot by exact id or unique prefix; undefined if unknown. */
	get(idOrPrefix: string): AgyTaskSnapshot | undefined {
		try {
			return this.snapshot(this.resolveTask(idOrPrefix));
		} catch {
			return undefined;
		}
	}

	// Borrowed from pi-background-tasks stopTask: SIGTERM, grace wait, SIGKILL,
	// POSIX process-group kill with child fallback (ESRCH treated as success).
	async stop(idOrPrefix: string): Promise<string> {
		const task = this.resolveTask(idOrPrefix);
		if (task.status !== "running") {
			return `Task ${task.id} is ${task.status}, not running.`;
		}
		task.killSignalSent = true;
		task.killStartedAt = Date.now();
		this.requestKill(task, "SIGTERM");
		const settled = await this.waitForEnd(task, KILL_GRACE_MS + 1_500);
		if (!settled) {
			this.requestKill(task, "SIGKILL");
			await this.waitForEnd(task, KILL_GRACE_MS);
		}
		return `Task ${task.id} (${task.name}) stopped. Output: ${task.outputPath}`;
	}

	/** agy manage_task 'send_input' — write a line to the task's stdin. */
	sendInput(idOrPrefix: string, input: string): string {
		const task = this.resolveTask(idOrPrefix);
		if (task.status !== "running") throw new Error(`Task ${task.id} is ${task.status}, not running`);
		const stdin = task.child?.stdin;
		if (!stdin) throw new Error(`Task ${task.id} has no stdin pipe`);
		stdin.write(input.endsWith("\n") ? input : `${input}\n`);
		return `Sent input to ${task.id} (${task.name}).`;
	}

	// Borrowed from pi-background-tasks getTaskLogs: bounded read with a
	// head/tail notice pointing at the full output file.
	async logs(idOrPrefix: string, maxBytes: number, tail: boolean): Promise<string> {
		const task = this.resolveTask(idOrPrefix);
		let stats;
		try {
			stats = await stat(task.outputPath);
		} catch {
			return `[No output file yet for ${task.id}: ${task.outputPath}]`;
		}
		const totalBytes = stats.size;
		const bytesToRead = Math.min(totalBytes, maxBytes);
		if (bytesToRead === 0) {
			return `(no output yet)\n\n[Full output: ${task.outputPath}]`;
		}
		const file = await open(task.outputPath, "r");
		try {
			const buffer = Buffer.alloc(bytesToRead);
			const position = tail ? Math.max(0, totalBytes - bytesToRead) : 0;
			const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
			let text = buffer.subarray(0, bytesRead).toString("utf8") || "(no output yet)";
			const truncated = totalBytes > bytesRead;
			if (truncated) {
				const notice = `\n\n[Showing ${tail ? "tail" : "head"} ${bytesRead} of ${totalBytes} bytes; ${totalBytes - bytesRead} omitted. Full output: ${task.outputPath}]`;
				text = tail ? `${notice}\n\n${text}` : `${text}${notice}`;
			} else {
				text += `\n\n[Full output: ${task.outputPath}]`;
			}
			return text;
		} finally {
			await file.close();
		}
	}

	// Borrowed from pi-background-tasks stopAllRunning.
	async stopAllRunning(): Promise<void> {
		await Promise.all(
			this.list()
				.filter((task) => task.status === "running")
				.map((task) => this.stop(task.id).catch(() => {})),
		);
	}

	/** Cancel everything on session shutdown. Idempotent. */
	async disposeAll(): Promise<void> {
		this.shuttingDown = true;
		await this.stopAllRunning();
	}

	// ------------------------------------------------------------------

	// Borrowed from pi-background-tasks requestPosixKill: signal the whole
	// process group; fall back to the child handle; ESRCH counts as success.
	private requestKill(task: InternalTask, signal: NodeJS.Signals): void {
		let killed = false;
		if (task.groupId !== null) {
			try {
				process.kill(task.groupId, signal);
				killed = true;
			} catch (error: any) {
				if (error?.code !== "ESRCH") {
					try {
						killed = task.child?.kill(signal) === true;
					} catch {
						/* fallthrough */
					}
				} else {
					killed = true;
				}
			}
		}
		if (!killed) {
			try {
				killed = task.child?.kill(signal) === true;
			} catch {
				/* process already gone */
			}
		}
		if (killed && signal === "SIGTERM" && !task.killEscalationTimer) {
			// Borrowed: escalate to SIGKILL after the grace period.
			task.killEscalationTimer = setTimeout(() => {
				if (!task.finalized) this.requestKill(task, "SIGKILL");
			}, KILL_GRACE_MS);
			task.killEscalationTimer.unref?.();
		}
	}

	private waitForEnd(task: InternalTask, timeoutMs: number): Promise<boolean> {
		if (task.finalized) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				child?.removeListener("close", onClose);
				resolve(false);
			}, timeoutMs);
			timer.unref?.();
			const child = task.child;
			if (!child) {
				clearTimeout(timer);
				resolve(task.finalized);
				return;
			}
			const onClose = () => {
				clearTimeout(timer);
				resolve(true);
			};
			child.once("close", onClose);
		});
	}

	// Borrowed from pi-background-tasks notifyCompletion + finalizeTask: XML
	// notification via sendMessage, followUp delivery, triggerTurn opt-in.
	private finalize(task: InternalTask, status: AgyTaskStatus, exitCode: number | null, signal: string | null): void {
		if (task.finalized) return;
		task.finalized = true;
		task.status = status;
		task.exitCode = exitCode;
		task.signal = signal;
		task.endedAt = Date.now();
		if (task.killEscalationTimer) {
			clearTimeout(task.killEscalationTimer);
			task.killEscalationTimer = null;
		}
		if (task.notified || this.shuttingDown) {
			this.opts.onTerminal?.(this.snapshot(task));
			return;
		}
		task.notified = true;
		const exit = exitCode === null ? "" : `\n  <exit-code>${String(exitCode)}</exit-code>`;
		const error = signal ? `\n  <signal>${escapeXml(signal)}</signal>` : "";
		const content = [
			"<background-task-notification>",
			`  <task-id>${task.id}</task-id>`,
			`  <task-name>${escapeXml(task.name)}</task-name>`,
			`  <status>${task.status}</status>`,
			exit,
			error,
			`  <output-file>${escapeXml(task.outputPath)}</output-file>`,
			`  <summary>${escapeXml(`Background task "${task.name}" ${task.status}`)}</summary>`,
			`  <guidance>Terminal state is durable. Do not re-list tasks to reconfirm; use manage_task status only if output details are needed.</guidance>`,
			"</background-task-notification>",
		]
			.filter(Boolean)
			.join("\n");
		this.opts.sendCompletionNotification(
			{ customType: "agy-task-notification", content, display: true, details: this.snapshot(task) },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		this.opts.onTerminal?.(this.snapshot(task));
	}

	// Borrowed from pi-background-tasks pruneOldTasks: cap remembered tasks.
	private pruneOldTasks(): void {
		const finished = [...this.tasks.values()].filter((task) => task.status !== "running");
		while (finished.length > MAX_RECENT_TASKS) {
			const oldest = finished.shift();
			if (oldest) this.tasks.delete(oldest.id);
		}
	}

	private snapshot(task: InternalTask): AgyTaskSnapshot {
		const { child: _c, groupId: _g, killSignalSent: _k, killEscalationTimer: _t, killStartedAt: _ks, notified: _n, finalized: _f, ...info } = task;
		return info;
	}
}

// --- borrowed from pi-background-tasks core/common.js ----------------------

export function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Borrowed: deriveTaskNameFromCommand + taskDisplayName.
export function taskDisplayName(command: string, name?: string): string {
	const trimmedName = name?.trim();
	if (trimmedName) return trimmedName;
	const normalized = command.replace(/\s+/g, " ").trim();
	if (!normalized) return "Background task";
	const packageScript = /^(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([^\s;&|]+)/.exec(normalized);
	if (packageScript) {
		const runner = packageScript[1] ?? "npm";
		const run = packageScript[2] !== undefined ? " run" : "";
		return truncateChars(`${runner}${run} ${packageScript[3] ?? ""}`, 48);
	}
	const words = normalized.split(/\s+/).slice(0, 5).join(" ");
	return truncateChars(words.length > 0 ? words : normalized, 48);
}

function truncateChars(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}
