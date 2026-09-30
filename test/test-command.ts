// Headless behavioral test for agy-mode using a mock ExtensionAPI.
// Run: node /tmp/agy-test-bootstrap/test-command.ts
import { register } from "node:module";

const mod = await import("./index.ts");
const factory = mod.default;

let activeTools: string[] = ["read", "bash", "edit", "write", "grep", "web_search", "fetch_content", "steer_subagent", "askUserQuestion"];
const calls: string[] = [];
const entries: Array<{ type: string; customType: string; data: unknown }> = [];
const handlers: Record<string, Function> = {};
let commandHandler: ((args: string, ctx: any) => Promise<void>) | null = null;
let registeredTools: string[] = [];

const notifications: string[] = [];

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

let failures = 0;
function check(n: string, c: boolean, e = "") { console.log(`${c ? "PASS" : "FAIL"} ${n}${e ? " — " + e : ""}`); if (!c) failures++; }
const statusCalls: Array<[string, string | undefined]> = [];
const makeCtx = (modelId: string | undefined, branch: any[] = []) => ({
	model: modelId ? { id: modelId, name: modelId } : undefined,
	cwd: "/tmp",
	mode: "tui",
	hasUI: true,
	ui: { notify: (msg: string) => notifications.push(msg), setStatus: (key: string, text: string | undefined) => { statusCalls.push([key, text]); } },
	sessionManager: { getBranch: () => branch },
});

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
if (!activeTools.includes("read") || !activeTools.includes("bash") || !activeTools.includes("askUserQuestion")) throw new Error("wrapped originals must stay active/callable");
if (!activeTools.includes("ask_question")) throw new Error("ask_question missing");

// before_agent_start in always mode with non-gemini -> prompt replaced
const result: any = await handlers["before_agent_start"](
	{ type: "before_agent_start", prompt: "hi", systemPrompt: "pi default prompt" },
	makeCtx("zai/glm-5.2", branch),
);
console.log("prompt replaced in always mode:", !!result?.systemPrompt, "| starts with identity:", result?.systemPrompt?.startsWith("<identity>"));
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

// status output (no args)
await commandHandler!("", makeCtx("google/gemini-3-pro", branch));
console.log("status notification:", JSON.stringify(notifications.at(-1)));

// settings default respected when no session entry exists
const pi2: any = { ...pi, getSettings: () => ({ agyMode: "always" }), appendEntry: () => {} };
const handlers2: Record<string, Function> = {};
// Persistence precedence: global state file (last /agy-mode choice) > settings.json > default
const { writeFileSync } = await import("node:fs");

// A) global file "always" beats settings "gemini-only" and default
writeFileSync(process.env.PI_CODING_AGENT_DIR + "/agy-mode.json", JSON.stringify({ mode: "always" }));
factory({
	registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
	getSettings: () => ({ agyMode: "gemini-only" }),
	getActiveTools: () => ["read", "bash", "edit", "write"],
	setActiveTools: (n: string[]) => { activeTools = n; },
	on: (e: string, h: Function) => { handlers2[e] = h; },
	sendMessage: async () => {},
	getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
} as any);
await handlers2["session_start"]({ type: "session_start" }, makeCtx("zai/glm-5.2", []));
console.log("global=always (file), settings=gemini-only, non-gemini ->", activeTools.includes("view_file") ? "agy tools ACTIVE (correct)" : "inactive (WRONG)");
if (!activeTools.includes("view_file")) throw new Error("global file should win");

// B) global file "off" beats settings "always"
writeFileSync(process.env.PI_CODING_AGENT_DIR + "/agy-mode.json", JSON.stringify({ mode: "off" }));
const handlers3: Record<string, Function> = {};
factory({
	registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
	getSettings: () => ({ agyMode: "always" }),
	getActiveTools: () => ["read", "bash", "edit", "write"],
	setActiveTools: (n: string[]) => { activeTools = n; },
	on: (e: string, h: Function) => { handlers3[e] = h; },
	sendMessage: async () => {},
	getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
} as any);
await handlers3["session_start"]({ type: "session_start" }, makeCtx("google/gemini-3-pro", []));
console.log("global=off (file), settings=always, gemini model ->", activeTools.includes("view_file") ? "ACTIVE (WRONG)" : "inactive (correct)");
if (activeTools.includes("view_file")) throw new Error("global off should suppress");

console.log("\nALL COMMAND TESTS PASSED");
