// Unit tests for agy-mode tasks.ts, schedule.ts, wrappers.ts (mock pi).
// Run from /tmp/agycheck: node --experimental-strip-types test-units.ts
import { rmSync } from "node:fs";
import { AgyTaskRegistry, DEFAULT_LOG_BYTES } from "../tasks.ts";
import { AgyScheduler, parseCron } from "../schedule.ts";
import { ensureCapabilityWrappers, hiddenOriginals, activeAgyToolNames, probeCapabilities } from "../wrappers.ts";

const DIR = "/tmp/agy-test-tasks";
rmSync(DIR, { recursive: true, force: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures++;
}

// ---- TaskRegistry -----------------------------------------------------
const notifications: Array<{ content: string; senderId: string; details?: any }> = [];
const registry = new AgyTaskRegistry({
	outputDir: DIR,
	sendCompletionNotification: (message, options) => {
		notifications.push({ content: message.content, senderId: message.details.id, details: message.details });
		check("notification options", options.triggerTurn === true && options.deliverAs === "followUp");
	},
});

const t1 = await registry.start("echo hello-bg; sleep 30", "/tmp", "sleeper");
check("start returns running task", t1.status === "running" && t1.id === "task-1", t1.id);
await sleep(300);
const listed = registry.list();
check("list shows running", listed.length === 1 && listed[0]!.status === "running");
const logs = await registry.logs("task-1", DEFAULT_LOG_BYTES, true);
check("logs contain output", logs.includes("hello-bg"), logs.slice(0, 60));
check("logs point at file", logs.includes(t1.outputPath));

// stdin
const t2 = await registry.start("cat", "/tmp");
await sleep(200);
check("prefix resolution", registry.get("2")?.id === "task-2");
const sendResult = registry.sendInput("task-2", "ping-from-test");
await sleep(200);
const catLogs = await registry.logs("task-2", DEFAULT_LOG_BYTES, true);
check("send_input reaches stdin", sendResult.includes("Sent input") && catLogs.includes("ping-from-test"));

// ambiguous prefix
let ambiguous = false;
try {
	registry.sendInput("task", "x");
} catch (e: any) {
	ambiguous = e.message.includes("Ambiguous");
}
check("ambiguous prefix error", ambiguous);

// kill
const killMsg = await registry.stop("task-1");
await sleep(150);
check("kill works", killMsg.includes("stopped") && registry.get("task-1")!.status === "killed", killMsg);

// graceful completion + notification + escapeXml content
const t3 = await registry.start("echo done-xyz", "/tmp");
await sleep(500);
check("completes", registry.get(t3.id)!.status === "completed" && registry.get(t3.id)!.exitCode === 0);
check("kill notified first", notifications[0]!.senderId === "task-1" && notifications[0]!.content.includes("<status>killed</status>"));
check("completion notification sent", notifications.length === 2 && notifications[1]!.senderId === t3.id, `n=${notifications.length}`);
check("notification is XML block", notifications[0]!.content.includes("<background-task-notification>") && notifications[0]!.content.includes("<task-id>"));
check("notification output in log", (await registry.logs(t3.id, DEFAULT_LOG_BYTES, true)).includes("done-xyz"));

// send_input on dead task errors
let deadErr = false;
try {
	registry.sendInput(t3.id, "x");
} catch {
	deadErr = true;
}
check("send_input on finished task errors", deadErr);

// ---- Scheduler --------------------------------------------------------
const schedNotifications: Array<{ senderId: string }> = [];
const scheduler = new AgyScheduler((_text, senderId) => {
	schedNotifications.push({ senderId });
});
const timer = scheduler.setTimer(1, "timer fired test");
check("timer armed", timer.state === "armed" && timer.id === "timer-1");
await sleep(1300);
const timerNow = scheduler.list().find((s) => s.id === timer.id);
check("timer fired + notified", timerNow?.state === "fired" && schedNotifications.some((n) => n.senderId === "timer-1"), timerNow?.state);

const condTimer = scheduler.setTimer(30, "should cancel", "task-9");
const keepTimer = scheduler.setTimer(30, "keep", "task-10");
const cancelled = scheduler.cancelOnNotification("task-9");
check("TimerCondition early-cancel", scheduler.list().find((s) => s.id === condTimer.id)?.state === "cancelled-early" && cancelled.length === 1);
check("non-matching condition survives", scheduler.list().find((s) => s.id === keepTimer.id)?.state === "armed");

// cron math
const next = parseCron("*/5 * * * *")(new Date("2026-10-01T10:03:00"));
check("cron */5 next", next !== null && next.getMinutes() === 5 && next.getHours() === 10, next?.toString() ?? "null");
const nextDaily = parseCron("0 9 * * *")(new Date("2026-10-01T10:03:00"));
check("cron daily 9am next", nextDaily !== null && nextDaily.getDate() === 2 && nextDaily.getHours() === 9, nextDaily?.toString() ?? "null");
const nextDow = parseCron("30 8 * * 1")(new Date("2026-10-01T10:03:00")); // Thu Oct 1 2026 -> Monday Oct 5
check("cron dow monday", nextDow !== null && nextDow.getDay() === 1 && nextDow.getDate() === 5, nextDow?.toString() ?? "null");
let cronErr = false;
try {
	parseCron("*/5 * *");
} catch {
	cronErr = true;
}
check("bad cron throws", cronErr);

const cronInfo = scheduler.setCron("*/5 * * * *", "cron prompt", 3);
check("cron armed", cronInfo.state === "armed" && cronInfo.kind === "cron");
check("cron cancel", scheduler.cancel(cronInfo.id).includes("cancelled"));

// ---- Capability wrappers ---------------------------------------------
const registeredTools: string[] = [];
const mockPi: any = {
	registerTool: (t: any) => registeredTools.push(t.name),
	getAllTools: () =>
		["read", "bash", "edit", "write", "grep", "web_search", "fetch_content"].map((name) => ({ name })),
};
const caps = probeCapabilities(mockPi);
check("probe", caps.webSearch && caps.fetchContent && !caps.steerSubagent);
ensureCapabilityWrappers(mockPi, caps);
check("wrappers registered for present caps", registeredTools.includes("search_web") && registeredTools.includes("read_url_content") && !registeredTools.includes("send_message"));
const hidden = hiddenOriginals(caps);
check("hides originals", hidden.includes("read") && hidden.includes("bash") && hidden.includes("web_search") && hidden.includes("fetch_content") && !hidden.includes("steer_subagent"));
const active = activeAgyToolNames(caps);
check("active agy names", active.includes("search_web") && active.includes("read_url_content") && active.includes("manage_task") && active.includes("schedule") && !active.includes("send_message"));
ensureCapabilityWrappers(mockPi, caps); // idempotent
check("idempotent registration", registeredTools.filter((n) => n === "search_web").length === 1);

// cleanup
await registry.disposeAll();
scheduler.cancelAll();
rmSync(DIR, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL UNIT TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
