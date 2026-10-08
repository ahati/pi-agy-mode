# pi-agy-mode

[Antigravity (agy)](https://antigravity.google) mode for [pi](https://pi.dev) — a coding agent extension that makes pi behave like the Antigravity CLI for **Gemini models**: it swaps in an Antigravity-style system prompt and renames pi's tools to the agy tool vocabulary (`view_file`, `run_command`, `write_to_file`, `replace_file_content`, `manage_task`, `schedule`, …), so Gemini models run against the tool surface they were tuned on.

Tool names and schemas mirror a captured Antigravity CLI 1.2.14 session.

## Why

Gemini models are heavily trained/RL'd on Antigravity agent traces. Running them with agy's system prompt and tool names elicits that trained behavior; running them with an unrelated prompt/tool vocabulary does not. This extension bridges the two worlds while keeping pi's engine (built-ins, permissions, session management) intact.

## Install

```bash
pi install git:github.com/ahati/pi-agy-mode@main
```

or try it for one session:

```bash
pi -e ./pi-agy-mode
```

Optional companion extensions (auto-detected if present — agy tools map onto them):

```bash
pi install npm:pi-web-access        # search_web -> web_search, read_url_content -> fetch_content
pi install git:github.com/ahati/pi-subagents@master  # send_message -> steer_subagent
pi install npm:pi-ask-user-question # ask_question delegates to askUserQuestion (richer UX)
```

Set a global default mode in `~/.pi/agent/settings.json` (optional):

```json
{ "agyMode": "always" }
```

## Usage: `/agy-mode`

| Command | Effect |
|---|---|
| `/agy-mode` | Show status (mode, model, mapped extensions, active tools) |
| `/agy-mode always` | Force agy prompt + tools for **every** model |
| `/agy-mode gemini-only` | Apply only when the model id/name matches `/gemini/i` (**default**) |
| `/agy-mode off` | Never apply; restores pi's normal prompt and tools |

Aliases: `on`/`force` → always; `gemini`/`auto`/`default` → gemini-only; `never`/`disabled` → off.

**Persistence** (highest precedence first):
1. Per-session entry — set via `/agy-mode` in the current session (survives `/reload` and resume)
2. `~/.pi/agent/agy-mode.json` — your last explicit `/agy-mode` choice, applied to all future sessions
3. `settings.json` `"agyMode"` key — manual default
4. Built-in default: `gemini-only`

## What you get

- **Verbatim Antigravity system prompt** — the exact CLI 1.2.14 capture (`agy-capture.ts`). Only session-specific values are substituted (OS, workspace/cwd, app data directory, conversation id) and the `<skills>` "Available skills" list is filled with the session's **pi skills** (discovered via pi's `loadSkills` plus installed pi-package skill directories). Three sections describing Antigravity product systems pi does not have are omitted: `<slash_commands>`, `<planning_mode>`, `<planning_mode_artifacts>`. Everything else is byte-for-byte from the capture.

One section is **added** from agy 1.2.16's planning artifacts (absent in the 1.2.14 capture): `<task_list>` — the `task.md` TODO-list convention with `[ ]` / `[/]` (in-progress, agy's custom notation) / `[x]` checkboxes, written under the brain directory as a living document.
- **agy-named tools** (originals hidden from the model in agy mode):

| agy tool | Delegates to | Notes |
|---|---|---|
| `view_file(AbsolutePath, StartLine?, EndLine?)` | pi `read` | range → offset/limit |
| `run_command(CommandLine, Cwd?, IsDaemon?)` | pi `bash` | `IsDaemon=true` starts a **managed background task** (see below) |
| `write_to_file(TargetFile, CodeContent, Overwrite?, Append?)` | pi `write` | errors if the file exists without `Overwrite=true` |
| `replace_file_content(TargetFile, TargetContent, ReplacementContent)` | pi `edit` | exact-match single replacement |
| `ask_question(questions[])` | pi dialogs **or** pi-ask-user-question `askUserQuestion` | delegates per-question when that extension is installed; falls back to `select`/`input`; degrades gracefully without UI |
| `manage_task(Action, TaskId?, Input?)` | **native** (this extension) | `list` / `status` / `kill` / **`send_input`** (stdin — not exposed by pi-background-tasks' `bg_*` tools) |
| `schedule(DurationSeconds \| CronExpression, Prompt, ...)` | **native** (this extension) | one-shot timers with `TimerCondition` (`never`/`any`/`<sender-id>`) + 5-field cron with `MaxIterations`; fires inject `<scheduled-notification>` and wake the agent |
| `search_web(query, domain?)` | pi-web-access `web_search` | when installed |
| `read_url_content(Url)` | pi-web-access `fetch_content` | when installed |
| `send_message(Recipient, Message)` | pi-subagents `steer_subagent` | steers a running subagent; when installed |

`generate_image` is intentionally not provided.

### Background tasks (borrowed from pi-background-tasks)

`run_command` with `IsDaemon=true` starts a managed background task: detached POSIX process group, merged output log under `.pi/agy-tasks/`, bounded log reads, SIGTERM→SIGKILL escalation, and automatic `<background-task-notification>` delivery that wakes a follow-up turn (do-not-poll semantics). Task patterns and helpers are borrowed from [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) (ISC) — see `tasks.ts` for per-section notes. agy-mode adds what `bg_*` tools lack: **stdin input** via `manage_task send_input`, and completion events that early-terminate `schedule` timers per `TimerCondition`.

The registry is session-scoped: tasks are killed on `session_shutdown` (no cross-reload survival).

Running tasks show in the status bar while any exist (pi-background-tasks-style dock, refreshed every 2s):

```
⬢ agy 2 tasks: task-1 sleeper (3m12s) · task-2 server (12s)
```

### Banner + status indicator

While agy mode is **active** (in TUI sessions):

- The startup banner is replaced with the **real Antigravity CLI banner** — the
  wing art reproduced byte-for-byte (per-character truecolor gradient extracted
  from a live `agy` render) with an info column showing the session model,
  mode and working directory, plus the separator line (deferred so it composes
  over theme extensions like pi-claude-style-tui; the previous header returns
  on the next session start after deactivating)
- The status bar shows **⬢ Antigravity-Mode (mode)** on the same row as the
  context/cost items; it clears when the mode is inactive

## Tool-surface parity

When active, the model sees **only** agy tool names — pi's `read`/`bash`/`edit`/`write` and the mapped originals (`web_search`, `fetch_content`, `steer_subagent`) are hidden from declarations while their functionality remains available through the wrappers. Tools from other extensions that have no agy counterpart (e.g. `SubagentWorkflow`, `bg_delegate`) stay declared as-is.

## Activation, headless sessions, and subagent hosts

agy-mode is a compatibility layer for Google models: activation is driven by the `/agy-mode` setting (or the `agyMode` key in settings.json) plus the model, **uniformly in every session** — interactive TUI, `pi -p`/RPC headless, and subagent sessions alike. A subagent's activation always mirrors the setting:

- **On** ⇒ the agy tool surface applies there too — `view_file`/`run_command`/… declared, originals hidden, `manage_task`/`schedule` live.
- **Off** ⇒ nothing applies, and agy tool declarations are hidden from requests even where a host re-activates registered tools every turn — a disabled agy-mode cannot leak into any agent's tool list.
- **Restricted toolsets.** Subagents often run with a subset of pi's built-ins; wrappers whose underlying tool is absent (e.g. `replace_file_content` without `edit`) are not activated — a declared tool that cannot execute is worse than an absent one.
- **Prompts.** Root sessions (TUI, `pi -p`, RPC) get the full agy prompt takeover when active. A hosted session's prompt was supplied by its creator (pi's `systemPromptOverride`, surfaced as `customPrompt`) — the tool surface follows the settings there, but the creator's prompt is kept, since replacing it would erase the agent's role and instructions (including structured-output contracts).
- **Subtractive discipline.** Leaving agy mode only ever removes agy's own tool names from the active set; tools activated by other extensions are never touched.

The hosted-prompt check is a pi-core API, not a convention of any host extension: no names, symbols, tool lists, or paths are referenced, so it holds for every subagent extension, present or future, nested agents at any depth included. Edge: a user-authored `SYSTEM.md` (`~/.pi/agent/SYSTEM.md` or `.pi/SYSTEM.md`) also counts as an owned prompt, so the agy prompt yields to it.

## Development

One-time dev setup (links pi's bundled modules; `node_modules/` is gitignored):

```bash
PI=$(dirname $(dirname $(readlink -f $(which pi))))/lib/node_modules/@earendil-works/pi-coding-agent
mkdir -p node_modules/@earendil-works
ln -sfn $PI/node_modules/typebox node_modules/typebox
ln -sfn $PI node_modules/@earendil-works/pi-coding-agent
ln -sfn $PI/node_modules/@types/node node_modules/@types/node
```

Then:

```bash
node --experimental-strip-types test/test-units.ts   # unit tests
node --experimental-strip-types test/test-command.ts # command/mode/persistence tests
npx tsc -p tsconfig.json                             # strict typecheck (sources)
```

## License

[ISC](./LICENSE). Portions borrowed from pi-background-tasks (ISC).
