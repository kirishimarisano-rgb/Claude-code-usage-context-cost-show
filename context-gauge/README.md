# Context Gauge

A usage gauge for Claude Code (2.1.287 or later). A thin band above the prompt shows how full the context window is, your 5-hour and weekly usage limits, and what the session has cost. It turns red as auto-compact or a limit gets close. While Claude works, it shows what is happening and has a Stop button.

Full documentation, screenshots and a Traditional Chinese version: <https://github.com/kirishimarisano-rgb/Claude-code-usage-context-cost-show>

## What it shows

- **Context**: how full the window is, in percent and tokens, with a `compacts soon` warning.
- **Usage limits**: the 5-hour and weekly windows with reset countdowns, and the session's cost.
- **While a task runs**: thinking, writing or which tool, how long each has taken, tokens per second, and a **■ Stop** button.
- **Done notice**: a toast when a turn that took over 20 seconds ends.
- **History** (≡): each prompt with its time, the opening of what you asked and of Claude's answer, and a jump back to it.
- **Claude status** (◉): the status page and your usage, fetched only when you press ↻ Refresh.
- **Model control**: five model and effort presets you pick with a press, with Fast mode and output style beside them.
- **Settings** (⚙ or `/gauge settings`): auto wrap-up near a limit, a `/compact` rule, three looks, text size, and switches for each feature.

Clients that draw no plugin UI, such as cloud sessions, get a one-line usage summary under each answer instead. Only you see it; the model never reads it.

## Commands

`/gauge` shows the gauge, and `/gauge settings` opens the settings. `/gauge usage` checks your limits now, and `/gauge status` checks Claude's service status. `/gauge history` opens the History window and `/gauge model 1-5` switches models. Run `/gauge help` for the full list.

## What it sends, runs and changes

**Network: two GET requests, and nothing else leaves your machine.**

- `https://api.anthropic.com/api/oauth/usage` reads your 5-hour and weekly usage, the same figures as `/usage`. It runs at session start, on ↻ Refresh, and on `/gauge usage`, at most once a minute. You can turn off the start-up check in settings. Claude Code attaches your login itself: the plugin only gets an opaque handle, never the token, and the handle can only reach Anthropic.
- `https://status.claude.com/api/v2/summary.json` reads Claude's public service status, only when you press ↻ Refresh. It sends no credentials.

**Model calls**: only if you turn on AI summaries in History (off by default). It then makes one short Haiku 5.5 call per prompt (or whichever Haiku `haiku` names where 5.5 is not served), and that uses tokens. A prompt you send while Claude is working is summarized with the task it joined.

**Commands it runs**: only when you press the matching control.

- `/model` and `/effort` for the model picker.
- `/fast` for Fast mode.
- `/config` (`outputStyle`) for the output style.
- `/plugin enable` or `/plugin disable` for Anthropic's built-in "You should know" side agent (`cc-plugin-you-should-know@builtin`).

**Changes to the conversation**:

- ■ Stop ends the running turn.
- Auto wrap-up (off by default) adds one fixed note to the running turn when a limit passes the threshold you set.
- The `/compact` rule reminds you by default. It compacts on its own only if you set it to Auto.

**Storage**: its settings, in Claude Code's plugin store. It never reads or writes your project's files and runs no programs.

The output of `/gauge` commands stays in the transcript like any command output. The band, the panes and the line under each answer are for you only.

## For reviewers: the mod's code, call by call

- **Hosts it contacts**: `api.anthropic.com` (`/api/oauth/usage`) and `status.claude.com` (`/api/v2/summary.json`), each written as a fixed address at its `$.http.fetch` call. Both are GET requests with no body. Neither answer is ever turned into a command: the code only reads numbers and status words from them, and caps every text it keeps.
- **Slash commands it runs** (`$.command.run`): only `/model`, `/effort`, `/fast` and `/plugin enable|disable cc-plugin-you-should-know@builtin`, each when you press its control. The `/model` and `/effort` arguments come from your own five presets, and a model id must match `^[A-Za-z0-9._:\-\[\]]{1,80}$` both when you type it and when it is used.
- **Settings it writes** (`$.config.set`): only `outputStyle`, when you pick a style. It reads the theme and output style with `$.config.list`. It does not hook `config.set`, permission checks, agents or files, so it never takes a permission decision.
- **What it reads of the conversation**: `session.append` and `turn.start` see your prompts, `turn.complete` sees the answer's text, and `tool.call` sees tool names and edited file paths. All of it stays in memory to draw History and the marks, and is cleared on restart. Only one thing leaves the machine: with AI summaries on, the opening of a prompt and of its answer go to Anthropic's model API through `$.model.complete`, the same way Claude Code's own requests do.
- **Conversation changes**: `$.turn.abort` (■ Stop), `$.session.append` (the fixed wrap-up note, off by default) and `$.session.compact` (the /compact rule set to Auto, off by default).
- **`tests/`**: the automated tests stub `http.fetch`, `model.complete` and other engine calls with fixed answers, so no test reaches the network. Claude Code never loads them in a session.

## Known limits

- Cloud sessions cannot read usage with their login, so their limits come from Claude's replies only.
- API-key and gateway logins have no 5-hour or weekly windows.
- The timeline only knows prompts sent since the plugin loaded.
- The plugin cannot see your plan: turn on "Max plan" in settings to unlock the Fable preset.

## License

MIT
