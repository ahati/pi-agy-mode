/**
 * Capability probing + agy-named wrappers that delegate to tools provided by
 * other extensions (when installed):
 *
 *   search_web       -> web_search        (pi-web-access)
 *   read_url_content -> fetch_content     (pi-web-access)
 *   send_message     -> steer_subagent    (pi-subagents)
 *
 * manage_task and schedule are provided natively by agy-mode (tasks.ts /
 * schedule.ts) and are not conditional.
 *
 * Probing runs per turn (before_agent_start) because other extensions may
 * register tools at load or from their own session_start handlers; late
 * registerTool is supported by pi.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface AgyCapabilities {
	webSearch: boolean;
	fetchContent: boolean;
	steerSubagent: boolean;
}

/** agy core wrappers that delegate to pi built-ins; always available. */
export const AGY_CORE_TOOLS = [
	"view_file",
	"run_command",
	"write_to_file",
	"replace_file_content",
	"ask_question",
	"manage_task",
	"schedule",
] as const;

/** pi tool names hidden from the model in agy mode (replaced by agy wrappers). */
export const CORE_WRAPPED_ORIGINALS = ["read", "bash", "edit", "write"];

interface CapabilityMapping {
	agyTool: string;
	originalTool: string;
	register: (pi: ExtensionAPI) => void;
}

/** Already-registered capability wrappers (registerTool replaces, so guard). */
const registered = new Set<string>();

export function probeCapabilities(pi: ExtensionAPI): AgyCapabilities {
	const names = new Set(pi.getAllTools().map((tool) => tool.name));
	return {
		webSearch: names.has("web_search"),
		fetchContent: names.has("fetch_content"),
		steerSubagent: names.has("steer_subagent"),
	};
}

/** Register wrappers for present capabilities; idempotent. */
export function ensureCapabilityWrappers(pi: ExtensionAPI, caps: AgyCapabilities): void {
	for (const mapping of CAPABILITY_MAPPINGS) {
		const present =
			(mapping.originalTool === "web_search" && caps.webSearch) ||
			(mapping.originalTool === "fetch_content" && caps.fetchContent) ||
			(mapping.originalTool === "steer_subagent" && caps.steerSubagent);
		if (present && !registered.has(mapping.agyTool)) {
			mapping.register(pi);
			registered.add(mapping.agyTool);
		}
	}
}

/** Names hidden from the model in agy mode: built-ins + originals we wrapped. */
export function hiddenOriginals(caps: AgyCapabilities): string[] {
	const hidden = [...CORE_WRAPPED_ORIGINALS];
	if (registered.has("search_web") && caps.webSearch) hidden.push("web_search");
	if (registered.has("read_url_content") && caps.fetchContent) hidden.push("fetch_content");
	if (registered.has("send_message") && caps.steerSubagent) hidden.push("steer_subagent");
	return hidden;
}

/** All agy tool names that should be declared, given the probed capabilities. */
export function activeAgyToolNames(caps: AgyCapabilities): string[] {
	const names: string[] = [...AGY_CORE_TOOLS];
	if (registered.has("search_web") && caps.webSearch) names.push("search_web");
	if (registered.has("read_url_content") && caps.fetchContent) names.push("read_url_content");
	if (registered.has("send_message") && caps.steerSubagent) names.push("send_message");
	return names;
}

/** Every agy tool name this extension can register (for exclusion sets). */
export function allAgyToolNames(): string[] {
	return [...AGY_CORE_TOOLS, "search_web", "read_url_content", "send_message"];
}

/** True if the name is an agy-mode wrapper (core or capability). */
export function isAgyTool(name: string): boolean {
	return (
		(AGY_CORE_TOOLS as readonly string[]).includes(name) ||
		name === "search_web" ||
		name === "read_url_content" ||
		name === "send_message"
	);
}

// Run a foreign tool via ctx.executeTool and surface failures as tool errors.
async function delegate(toolCtx: { executeTool: (name: string, args: unknown) => Promise<any> }, name: string, args: unknown) {
	const outcome = await toolCtx.executeTool(name, args);
	if (outcome.isError) {
		const text = (outcome.result?.content ?? [])
			.map((c: any) => (c && typeof c === "object" && "text" in c ? String(c.text) : ""))
			.join("\n");
		throw new Error(text || `Delegated tool ${name} failed`);
	}
	return outcome.result;
}

const CAPABILITY_MAPPINGS: CapabilityMapping[] = [
	{
		agyTool: "search_web",
		originalTool: "web_search",
		register: (pi) => {
			pi.registerTool({
				name: "search_web",
				label: "search_web",
				description:
					"Performs a web search for a given query. Returns a summary of relevant information along with URL citations.",
				parameters: Type.Object({
					query: Type.String({ description: "The search query." }),
					domain: Type.Optional(Type.String({ description: "Limit results to this domain (e.g. 'docs.python.org')." })),
					toolAction: Type.Optional(Type.String({ description: "Brief 2-5 word -ing phrase describing the action." })),
					toolSummary: Type.Optional(Type.String({ description: "Brief 2-5 word noun phrase describing the task." })),
				}),
				async execute(_id, params, _signal, _onUpdate, toolCtx) {
					const args: Record<string, unknown> = { query: params.query };
					if (params.domain) args.domainFilter = [params.domain];
					return delegate(toolCtx, "web_search", args);
				},
			});
		},
	},
	{
		agyTool: "read_url_content",
		originalTool: "fetch_content",
		register: (pi) => {
			pi.registerTool({
				name: "read_url_content",
				label: "read_url_content",
				description:
					"Fetch content from a URL via HTTP request (invisible to USER). Use when: (1) extracting text from public pages, " +
					"(2) reading static content/documentation, (3) batch processing multiple URLs, (4) speed is important. " +
					"Converts HTML to markdown. No JavaScript execution.",
				parameters: Type.Object({
					Url: Type.String({ description: "The URL to fetch." }),
					toolAction: Type.Optional(Type.String({ description: "Brief 2-5 word -ing phrase describing the action." })),
					toolSummary: Type.Optional(Type.String({ description: "Brief 2-5 word noun phrase describing the task." })),
				}),
				async execute(_id, params, _signal, _onUpdate, toolCtx) {
					return delegate(toolCtx, "fetch_content", { url: params.Url });
				},
			});
		},
	},
	{
		agyTool: "send_message",
		originalTool: "steer_subagent",
		register: (pi) => {
			pi.registerTool({
				name: "send_message",
				label: "send_message",
				description:
					"Send a message to another agent. Use it to steer a running subagent mid-run by its agent ID or memorable name. " +
					"Do not use this tool to communicate with the user.",
				parameters: Type.Object({
					Recipient: Type.String({ description: "The target agent's ID or memorable name (e.g. 'auth-audit')." }),
					Message: Type.String({ description: "The steering message to send." }),
					toolAction: Type.Optional(Type.String({ description: "Brief 2-5 word -ing phrase describing the action." })),
					toolSummary: Type.Optional(Type.String({ description: "Brief 2-5 word noun phrase describing the task." })),
				}),
				async execute(_id, params, _signal, _onUpdate, toolCtx) {
					return delegate(toolCtx, "steer_subagent", { agent_id: params.Recipient, message: params.Message });
				},
			});
		},
	},
];
