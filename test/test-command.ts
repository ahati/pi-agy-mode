// Headless behavioral test for agy-mode using a mock ExtensionAPI.
// Run from /tmp/agycheck: node --experimental-strip-types test-command.ts
const mod = await import("../index.ts");
const factory = mod.default;

let activeTools: string[] = ["read", "bash", "edit", "write", "grep", "web_search", "fetch_content", "steer_subagent", "askUserQuestion"];
const calls: string[] = [];
const entries: Array<{ type: string; customType: string; data: unknown }> = [];
const handlers: Record<string, Function> = {};
let commandHandler: ((args: string, ctx: any) => Promise<void>) | null = null;
let registeredTools: string[] = [];

const notifications: string[] = [];
// settable reply for the mock select dialog
const uiSelectReply: { value: string | undefined } = { value: undefined };
const statusCalls: Array<[string, string | undefined]> = [];

const pi: any = {
	registerTool: (t: any) => registeredTools.push(t.name),
	registerCommand: (_name: string, cmd: any) => { commandHandler = cmd.handler; },
	on: (event: string, handler: Function) => { handlers[event] = handler; },
	getSettings: () => ({ agyMode: "off" }), // global default = off (should be overridden by session entry)
	appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	getActiveTools: () => [...activeTools],
	setActiveTools: (names: string[]) => { calls.push(`setActiveTools(${names.join(",")})`); activeTools = [...names]; },
	sendMessage: async () => {},
	getAllTools: () => [...activeTools, "web_search", "fetch_content", "steer_subagent", "askUserQuestion"].map((name) => ({ name })),
};

const makeCtx = (modelId: string | undefined, branch: any[] = []) => ({
	model: modelId ? { id: modelId, name: modelId } : undefined,
	cwd: "/tmp",
	mode: "tui",
	hasUI: true,
	ui: {
		notify: (msg: string) => notifications.push(msg),
		setStatus: (key: string, text: string | undefined) => { statusCalls.push([key, text]); },
		select: async (_title: string, options: string[]) => {
			if (uiSelectReply.value === "@ticked") {
				return options.find((o) => o.startsWith("✓"));
			}
			return uiSelectReply.value;
		},
	},
	sessionManager: { getBranch: () => branch },
});

let failures = 0;
function check(n: string, c: boolean, e = "") { console.log(`${c ? "PASS" : "FAIL"} ${n}${e ? " — " + e : ""}`); if (!c) failures++; }

// Session with a persisted "always" entry (simulates /agy-mode always earlier in this session)
const branch = [{ type: "custom", customType: "agy-mode", data: { mode: "always" } }];

factory(pi);
console.log("registered tools:", registeredTools.join(","));
if (!["view_file","run_command","write_to_file","replace_file_content","ask_question","manage_task","schedule"].every((n) => registeredTools.includes(n))) {
	throw new Error("unexpected tool registration");
}

// session_start with non-gemini model + persisted "always" -> agy tools active
await handlers["session_start"]({ type: "session_start" }, makeCtx("zai/glm-5.2", branch));
console.log("after session_start (always, non-gemini):", activeTools.join(","));
if (!activeTools.includes("view_file")) throw new Error("always mode failed");
// originals stay ACTIVE (callable for delegation); declarations are hidden via prepareLoadout
if (!activeTools.includes("read") || !activeTools.includes("bash")) throw new Error("wrapped originals must stay active/callable");
if (!activeTools.includes("ask_question")) throw new Error("ask_question missing");

// before_agent_start in always mode with non-gemini -> prompt replaced
const result: any = await handlers["before_agent_start"](
	{ type: "before_agent_start", prompt: "hi", systemPrompt: "pi default prompt" },
	makeCtx("zai/glm-5.2", branch),
);
console.log("prompt replaced in always mode:", !!result?.systemPrompt, "| identity verbatim:", result?.systemPrompt?.startsWith("<identity>\nYou are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team"));
if (!result?.systemPrompt?.startsWith("<identity>")) throw new Error("prompt not forced in always mode");

// /agy-mode off -> restores base tools
await commandHandler!("off", makeCtx("zai/glm-5.2", branch));
console.log("after /agy-mode off:", activeTools.join(","));
if (activeTools.includes("view_file") || !activeTools.includes("read")) throw new Error("off mode failed to restore");

// before_agent_start in off mode -> no override
const offResult: any = await handlers["before_agent_start"](
	{ type: "before_agent_start", prompt: "hi", systemPrompt: "pi default" },
	makeCtx("zai/glm-5.2", branch),
);
console.log("prompt override in off mode:", offResult?.systemPrompt ?? "(none)");
if (offResult?.systemPrompt) throw new Error("prompt should not be forced in off mode");

// /agy-mode gemini-only + gemini model -> wrappers back
await commandHandler!("gemini-only", makeCtx("google/gemini-3-pro", branch));
console.log("after /agy-mode gemini-only (gemini model):", activeTools.join(","));
if (!activeTools.includes("view_file") || !activeTools.includes("read")) throw new Error("gemini-only failed");

// /agy-mode gemini-only + non-gemini model -> base tools
await commandHandler!("gemini-only", makeCtx("zai/glm-5.2", branch));
console.log("after /agy-mode gemini-only (non-gemini):", activeTools.join(","));
if (activeTools.includes("view_file") || !activeTools.includes("read")) throw new Error("gemini-only negative failed");

// bad arg
await commandHandler!("bogus", makeCtx("zai/glm-5.2", branch));
console.log("bad-arg notification:", notifications.at(-1));

// persisted entries written for each set
console.log("persisted entries:", entries.map((e) => (e.data as any).mode).join(","));

// --- selector UI path ---
// dismissed (Escape) -> no change, no entries appended
const entriesBefore = entries.length;
uiSelectReply.value = undefined;
await commandHandler!("", makeCtx("zai/glm-5.2", branch));
check("selector dismissed -> no change", entries.length === entriesBefore);

// pick the ticked option -> same mode -> unchanged notice
uiSelectReply.value = "@ticked"; // mock returns the option starting with ✓ (current: gemini-only)
await commandHandler!("", makeCtx("zai/glm-5.2", branch));
check("selector same-mode pick -> unchanged notice", notifications.at(-1)!.includes("unchanged (gemini-only)"));

// switch to always via selector
uiSelectReply.value = "always";
await commandHandler!("", makeCtx("zai/glm-5.2", branch));
check("selector picked always -> applied + persisted", (entries.at(-1)!.data as any).mode === "always");
console.log("status after selector pick:", notifications.at(-1)!.split("\n")[0]);

// status display (no args, dismissed) shows current mode
uiSelectReply.value = undefined;
await commandHandler!("", makeCtx("google/gemini-3-pro", branch));
console.log("status notification:", JSON.stringify(notifications.at(-1)!.split("\n")[0]));

// settings default respected when no session entry AND no global file choice
const activeTools2 = ["read", "bash", "edit", "write"];
const handlers2: Record<string, Function> = {};
factory({
	registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
	getSettings: () => ({ agyMode: "always" }),
	getActiveTools: () => [...activeTools2],
	setActiveTools: (n: string[]) => { activeTools2.length = 0; activeTools2.push(...n); },
	on: (e: string, h: Function) => { handlers2[e] = h; },
	sendMessage: async () => {},
	getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
} as any);
await handlers2["session_start"]({ type: "session_start" }, makeCtx("zai/glm-5.2", []));
console.log("settings default=always, non-gemini, no session entry ->", activeTools2.includes("view_file") ? "agy tools ACTIVE (correct)" : "inactive (WRONG)");
if (!activeTools2.includes("view_file")) throw new Error("settings default should win when no persisted global choice");

// Persistence precedence: global state file (last /agy-mode choice) > settings.json > default
const { writeFileSync } = await import("node:fs");

// A) global file "always" beats settings "gemini-only" and default
writeFileSync(process.env.PI_CODING_AGENT_DIR + "/agy-mode.json", JSON.stringify({ mode: "always" }));
const activeToolsA = ["read", "bash", "edit", "write"];
const handlersA: Record<string, Function> = {};
factory({
	registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
	getSettings: () => ({ agyMode: "gemini-only" }),
	getActiveTools: () => [...activeToolsA],
	setActiveTools: (n: string[]) => { activeToolsA.length = 0; activeToolsA.push(...n); },
	on: (e: string, h: Function) => { handlersA[e] = h; },
	sendMessage: async () => {},
	getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
} as any);
await handlersA["session_start"]({ type: "session_start" }, makeCtx("zai/glm-5.2", []));
console.log("global=always (file), settings=gemini-only, non-gemini ->", activeToolsA.includes("view_file") ? "agy tools ACTIVE (correct)" : "inactive (WRONG)");
if (!activeToolsA.includes("view_file")) throw new Error("global file should win");

// B) global file "off" beats settings "always"
writeFileSync(process.env.PI_CODING_AGENT_DIR + "/agy-mode.json", JSON.stringify({ mode: "off" }));
const activeToolsB = ["read", "bash", "edit", "write"];
const handlersB: Record<string, Function> = {};
factory({
	registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
	getSettings: () => ({ agyMode: "always" }),
	getActiveTools: () => [...activeToolsB],
	setActiveTools: (n: string[]) => { activeToolsB.length = 0; activeToolsB.push(...n); },
	on: (e: string, h: Function) => { handlersB[e] = h; },
	sendMessage: async () => {},
	getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
} as any);
await handlersB["session_start"]({ type: "session_start" }, makeCtx("google/gemini-3-pro", []));
console.log("global=off (file), settings=always, gemini model ->", activeToolsB.includes("view_file") ? "ACTIVE (WRONG)" : "inactive (correct)");
if (activeToolsB.includes("view_file")) throw new Error("global off should suppress");

check("status dock cleared (undefined) with no tasks", statusCalls.length > 0 && statusCalls.every(([k]) => k === "agy-tasks") && statusCalls.every(([, v]) => v === undefined), JSON.stringify(statusCalls));
console.log("ALL COMMAND TESTS PASSED");
if (failures > 0) process.exit(1);
