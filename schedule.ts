/**
 * Native implementation of agy's `schedule` tool: one-shot timers and
 * recurring cron jobs that deliver a notification and wake the agent.
 *
 * Semantics follow the Antigravity capture (20260930-215001_29e0f745.json):
 * - One-shot: DurationSeconds + Prompt, optional TimerCondition
 *   ('never' | 'any' | <sender-id>) for early termination when a matching
 *   message (task notification, steer reply) arrives first.
 * - Cron: 5-field CronExpression + Prompt, optional MaxIterations.
 * All schedules are session-scoped and torn down on session_shutdown.
 */

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days per chained segment
const MAX_CRON_LOOKAHEAD_MINUTES = 366 * 24 * 60; // 1 year
const MAX_ACTIVE_SCHEDULES = 20;

export type TimerCondition = "never" | "any" | string;

export interface AgyScheduleInfo {
	id: string;
	kind: "timer" | "cron";
	prompt: string;
	condition?: TimerCondition;
	cronExpression?: string;
	maxIterations?: number;
	fires: number;
	state: "armed" | "fired" | "cancelled" | "cancelled-early" | "expired";
}

interface InternalSchedule extends AgyScheduleInfo {
	timer: ReturnType<typeof setTimeout> | null;
	nextFireAt: number | null;
	createdAt: number;
}

export class AgyScheduler {
	private schedules = new Map<string, InternalSchedule>();
	private counter = 0;
	private shutdown = false;

	private notify: (text: string, senderId: string) => void;

	constructor(notify: (text: string, senderId: string) => void) {
		this.notify = notify;
	}

	setTimer(durationSeconds: number, prompt: string, condition: TimerCondition = "never"): AgyScheduleInfo {
		this.assertCapacity();
		const id = `timer-${++this.counter}`;
		const clamped = Math.max(1, Math.floor(durationSeconds));
		const schedule: InternalSchedule = {
			id,
			kind: "timer",
			prompt,
			condition,
			fires: 0,
			state: "armed",
			nextFireAt: Date.now() + clamped * 1000,
			createdAt: Date.now(),
			timer: null,
		};
		this.schedules.set(id, schedule);
		this.armTimer(schedule, clamped * 1000);
		return this.info(schedule);
	}

	setCron(expression: string, prompt: string, maxIterations?: number): AgyScheduleInfo {
		const nextFn = parseCron(expression); // throws on invalid expressions
		this.assertCapacity();
		const id = `cron-${++this.counter}`;
		const schedule: InternalSchedule = {
			id,
			kind: "cron",
			prompt,
			cronExpression: expression,
			maxIterations: maxIterations !== undefined ? Math.max(1, Math.floor(maxIterations)) : undefined,
			fires: 0,
			state: "armed",
			nextFireAt: null,
			createdAt: Date.now(),
			timer: null,
		};
		this.schedules.set(id, schedule);
		this.advanceCron(schedule, nextFn);
		return this.info(schedule);
	}

	/**
	 * Early-terminate timers per TimerCondition. Called by index.ts when a
	 * notification arrives; senderId is e.g. "task-3" (background task) or
	 * another timer/cron id.
	 */
	cancelOnNotification(senderId: string): AgyScheduleInfo[] {
		const cancelled: AgyScheduleInfo[] = [];
		for (const schedule of this.schedules.values()) {
			if (schedule.kind !== "timer" || schedule.state !== "armed") continue;
			const condition = schedule.condition ?? "never";
			if (condition === "any" || condition === senderId) {
				this.settle(schedule, "cancelled-early");
				cancelled.push(this.info(schedule));
			}
		}
		return cancelled;
	}

	list(): AgyScheduleInfo[] {
		return [...this.schedules.values()].map((schedule) => this.info(schedule));
	}

	cancel(idOrPrefix: string): string {
		const schedule = this.resolve(idOrPrefix);
		if (schedule.state !== "armed") return `Schedule ${schedule.id} already ${schedule.state}.`;
		this.settle(schedule, "cancelled");
		return `Schedule ${schedule.id} cancelled.`;
	}

	cancelAll(): void {
		this.shutdown = true;
		for (const schedule of this.schedules.values()) {
			if (schedule.timer) clearTimeout(schedule.timer);
			if (schedule.state === "armed") schedule.state = "cancelled";
		}
	}

	// ------------------------------------------------------------------

	private assertCapacity(): void {
		const armed = [...this.schedules.values()].filter((schedule) => schedule.state === "armed").length;
		if (armed >= MAX_ACTIVE_SCHEDULES) {
			throw new Error(`Too many active schedules (${armed}). Cancel one first with schedule id.`);
		}
	}

	private armTimer(schedule: InternalSchedule, ms: number): void {
		if (this.shutdown) return;
		// Node timers cannot exceed 2^31-1 ms; chain long durations.
		const segment = Math.min(ms, MAX_DURATION_MS);
		schedule.timer = setTimeout(() => {
			const remaining = ms - segment;
			if (remaining > 0) {
				this.armTimer(schedule, remaining);
			} else {
				this.fire(schedule);
			}
		}, segment);
		schedule.timer.unref?.();
	}

	private advanceCron(schedule: InternalSchedule, nextFn: (from: Date) => Date | null): void {
		if (this.shutdown) return;
		const next = nextFn(new Date());
		if (!next) {
			schedule.state = "expired";
			return;
		}
		schedule.nextFireAt = next.getTime();
		const delay = Math.max(0, next.getTime() - Date.now());
		schedule.timer = setTimeout(() => {
			schedule.fires += 1;
			this.deliver(schedule, `cron ${schedule.cronExpression} (fire ${schedule.fires})`);
			if (schedule.maxIterations !== undefined && schedule.fires >= schedule.maxIterations) {
				schedule.state = "expired";
				return;
			}
			this.advanceCron(schedule, nextFn);
		}, delay);
		schedule.timer.unref?.();
	}

	private fire(schedule: InternalSchedule): void {
		schedule.fires += 1;
		schedule.state = "fired";
		this.deliver(schedule, `${schedule.kind} ${schedule.id} expiry`);
	}

	private deliver(schedule: InternalSchedule, origin: string): void {
		this.notify(
			`<scheduled-notification>\n  <schedule-id>${schedule.id}</schedule-id>\n` +
				`  <origin>${escapeXml(origin)}</origin>\n` +
				`  <prompt>${escapeXml(schedule.prompt)}</prompt>\n` +
				`  <guidance>This scheduled notification arrived. Address the prompt above. To wait again, set a new schedule and end your turn; do not poll.</guidance>\n` +
				`</scheduled-notification>`,
			schedule.id,
		);
	}

	private settle(schedule: InternalSchedule, state: "cancelled" | "cancelled-early"): void {
		if (schedule.timer) clearTimeout(schedule.timer);
		schedule.timer = null;
		schedule.state = state;
	}

	// Borrowed from pi-background-tasks resolveTask: exact then unique prefix.
	private resolve(idOrPrefix: string): InternalSchedule {
		const id = idOrPrefix.trim();
		if (!id) throw new Error("Schedule ID is required");
		const exact = this.schedules.get(id);
		if (exact) return exact;
		const matches = [...this.schedules.values()].filter((schedule) => schedule.id.startsWith(id));
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) {
			throw new Error(`Ambiguous schedule ID prefix "${id}": ${matches.map((schedule) => schedule.id).join(", ")}`);
		}
		throw new Error(`Unknown schedule ID: ${id}`);
	}

	private info(schedule: InternalSchedule): AgyScheduleInfo {
		const { timer: _t, nextFireAt: _n, createdAt: _c, ...info } = schedule;
		return info;
	}
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 5-field cron parser (minute hour day-of-month month day-of-week).
 * Supports `*`, lists (`a,b`), ranges (`a-b`), steps (`*\/n`, `a-b/n`).
 * Day-of-week: 0-7 (0 and 7 are Sunday). Returns a function computing the
 * next fire time strictly after a given minute, or null beyond 1 year.
 */
export function parseCron(expression: string): (from: Date) => Date | null {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`CronExpression must have 5 fields (minute hour day-of-month month day-of-week), got: "${expression}"`);
	}
	const minute = parseField(fields[0]!, 0, 59);
	const hour = parseField(fields[1]!, 0, 23);
	const dayOfMonth = parseField(fields[2]!, 1, 31);
	const month = parseField(fields[3]!, 1, 12);
	// Normalize 7 -> 0 (Sunday), as in standard cron.
	const dayOfWeek = new Set([...parseField(fields[4]!, 0, 7)].map((value) => value % 7));

	return (from: Date) => {
		const cursor = new Date(from.getTime());
		cursor.setSeconds(0, 0);
		cursor.setMinutes(cursor.getMinutes() + 1);
		for (let i = 0; i < MAX_CRON_LOOKAHEAD_MINUTES; i++) {
			if (
				minute.has(cursor.getMinutes()) &&
				hour.has(cursor.getHours()) &&
				month.has(cursor.getMonth() + 1) &&
				dayOfMonth.has(cursor.getDate()) &&
				dayOfWeek.has(cursor.getDay())
			) {
				return new Date(cursor.getTime());
			}
			cursor.setMinutes(cursor.getMinutes() + 1);
		}
		return null;
	};
}

function parseField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		const [rangePart, stepPart] = part.split("/");
		const step = stepPart !== undefined ? Number(stepPart) : 1;
		if (!Number.isInteger(step) || step < 1) {
			throw new Error(`Invalid cron step in "${field}"`);
		}
		let start = min;
		let end = max;
		if (rangePart !== "*" && rangePart !== undefined) {
			const [lo, hi] = rangePart.split("-");
			start = Number(lo);
			end = hi !== undefined ? Number(hi) : start;
			if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
				throw new Error(`Invalid cron range "${rangePart}" (expected ${min}-${max})`);
			}
		}
		for (let value = start; value <= end; value += step) values.add(value);
	}
	if (values.size === 0) throw new Error(`Empty cron field "${field}"`);
	return values;
}
