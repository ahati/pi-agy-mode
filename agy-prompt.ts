import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	loadSkills,
	loadSkillsFromDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { AGY_CAPTURE_PROMPT } from "./agy-capture.ts";

/**
 * Builds the Antigravity system prompt: the verbatim CLI capture with only
 * session-specific values substituted (OS, workspace, app data dir,
 * conversation id) and the <skills> "Available skills" list filled with the
 * session's pi skills — discovered the same way pi discovers them (default
 * directories plus installed pi-package skills).
 */
export function buildAgySystemPrompt(ctx: ExtensionContext, pi: ExtensionAPI): string {
	const agentDir = getAgentDir();
	let conversationId: string;
	try {
		conversationId = ctx.sessionManager.getSessionId();
	} catch {
		conversationId = "unknown";
	}

	const skills = collectSkills(ctx, pi, agentDir)
		.filter((skill) => !skill.disableModelInvocation)
		.map((skill) => `- ${skill.name} (${skill.filePath}): ${skill.description}`);

	const skillsList = skills.length > 0 ? skills.join("\n") : "(no skills available)";

	// Task-list convention from agy 1.2.16's planning artifacts (task.md with
	// the custom [/] in-progress notation). Placeholders <appDataDir> /
	// <conversation-id> are kept literal, exactly like the captured prompt —
	// the model composes them from <user_information>.
	const taskList = `<task_list>
When working on an approved plan or a multi-step task, organize your work with a TODO list artifact.

# Tasks
Path: <appDataDir>/brain/<conversation-id>/task.md

**Purpose**: A TODO list to organize your work during execution. Break down complex tasks into component-level items and track progress as a living document.

**Format**:
- \`[ ]\` uncompleted tasks
- \`[/]\` in progress tasks (custom notation)
- \`[x]\` completed tasks
- Use indented lists for sub-items

**Updating task.md**: Mark items as \`[/]\` when starting work on them, and \`[x]\` when completed. Update task.md as you make progress through your checklist.
</task_list>`;

	return AGY_CAPTURE_PROMPT.replaceAll("__AGY_OS__", process.platform)
		.replaceAll("__AGY_WORKSPACE__", ctx.cwd)
		.replaceAll("__AGY_CWD__", ctx.cwd)
		.replaceAll("__AGY_APP_DATA_DIR__", agentDir)
		.replaceAll("__AGY_CONVERSATION_ID__", conversationId)
		.replaceAll("__AGY_SKILLS_LIST__", skillsList) + "\n" + taskList;
}

/** All skills pi would advertise for this session (defaults + installed pi packages). */
function collectSkills(ctx: ExtensionContext, pi: ExtensionAPI, agentDir: string): Skill[] {
	const byFile = new Map<string, Skill>();

	// Default locations (~/.pi/agent/skills, project .pi/skills, .agents/skills, ...)
	for (const skill of loadSkills({ cwd: ctx.cwd, agentDir, skillPaths: [], includeDefaults: true }).skills) {
		byFile.set(skill.filePath, skill);
	}

	// Installed pi packages: npm:<pkg> -> <agentDir>/npm/node_modules/<pkg>,
	// git:<host>/<org>/<repo> -> <agentDir>/git/<host>/<org>/<repo>.
	// Skills come from the package manifest's pi.skills entries or the
	// conventional <package>/skills directory. Per-package settings filters
	// (e.g. { skills: [] }) are not applied here.
	for (const pkg of installedPackages(agentDir, pi.getSettings())) {
		const skillDirs = pkg.declaredSkills.length > 0
			? pkg.declaredSkills.map((d) => join(pkg.dir, d))
			: [join(pkg.dir, "skills")];
		for (const dir of skillDirs) {
			try {
				for (const skill of loadSkillsFromDir({ dir, source: dir }).skills) {
					byFile.set(skill.filePath, skill);
				}
			} catch {
				// missing or unreadable directory — skip
			}
		}
	}

	return [...byFile.values()];
}

interface PackageLocation {
	dir: string;
	/** manifest pi.skills entries (non-glob paths); empty when unknown */
	declaredSkills: string[];
}

function installedPackages(agentDir: string, settings: ReturnType<ExtensionAPI["getSettings"]>): PackageLocation[] {
	const list = Array.isArray((settings as Record<string, unknown>).packages)
		? ((settings as Record<string, unknown>).packages as unknown[])
		: [];
	const out: PackageLocation[] = [];
	for (const entry of list) {
		const source = typeof entry === "string" ? entry : (entry as { source?: unknown })?.source;
		if (typeof source !== "string") continue;
		let dir: string | undefined;
		if (source.startsWith("npm:")) {
			dir = join(agentDir, "npm", "node_modules", stripVersion(source.slice(4)));
		} else if (source.startsWith("git:")) {
			const match = /^git:([^/]+)\/([^/]+)\/([^/@]+)(@.*)?$/.exec(source);
			if (match) dir = join(agentDir, "git", match[1]!, match[2]!, match[3]!);
		} else {
			continue; // local paths load in place, not from the agent dir
		}
		if (!dir) continue;

		let declaredSkills: string[] = [];
		try {
			const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
				pi?: { skills?: unknown };
			};
			if (Array.isArray(manifest.pi?.skills)) {
				declaredSkills = (manifest.pi!.skills as unknown[]).filter(
					(d): d is string => typeof d === "string" && !d.includes("*"),
				);
			}
		} catch {
			// no manifest — fall back to the conventional skills directory
		}
		out.push({ dir, declaredSkills });
	}
	return out;
}

function stripVersion(name: string): string {
	// "@scope/name@1.2.3" -> "@scope/name"; "name@1.2.3" -> "name"
	const at = name.lastIndexOf("@");
	return at > 0 ? name.slice(0, at) : name;
}
