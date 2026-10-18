# Changelog

## context-gauge 1.1.6

- For Anthropic's plugin directory: `Client`, `Svg` and `Input` now come straight off `$.ui.resolve(e)`, with no type casts, and the slider is drawn by one helper. The directory can now follow the `Client` element to its fixed module path, `./slider.tsx`.

## context-gauge 1.1.5

- For Anthropic's plugin directory: a callback parameter named `h`, the JSX factory's name, made the directory distrust every element in the file, so it could not read the slider's module path. The parameter is renamed, and the slider is written as a plain `<Client module="./slider.tsx">` tag again.

## context-gauge 1.1.4

- For Anthropic's plugin directory: the slider's module path is written in the object form the directory reads, the two fetch addresses are fixed at their calls, and a parameter that shadowed `on` is renamed.
- The mod no longer hooks `config.set`. It reads the theme and output style when a turn starts, so it can never sit in the way of a settings write.
- A plugin icon, and a README section that walks a reviewer through every call that sends, runs or changes something.

## context-gauge 1.1.3

- Fixed: a prompt sent while Claude was working took over the line of the task still running. That line turned amber as if stopped, and its time, answer and AI summary landed on the new prompt. Each History line now belongs to the turn that answered it.
- A prompt sent while Claude works now gets its own line too. If Claude folds it into the running task, the line says "sent mid-task" and the task's summary covers both requests; if it waits for its own turn, it keeps one line.
- AI summaries use Haiku 5.5, falling back to whichever Haiku `haiku` names where 5.5 is not served. A summary that cannot be made now says why (for example `rate_limit 429`) instead of vanishing.
- `/gauge history` draws live on mobile, as `/gauge timeline` did.

## context-gauge 1.1.2

- Ready for Anthropic's plugin directory: a README inside the plugin folder that lists everything it sends, runs and changes; `displayName`, `homepage`, `repository` and `keywords` in `plugin.json`.
- `/gauge help` lists the commands.

## Claude Widget 0.3.0

- Clear glass by default: the desktop shows through untouched, with a tint you set (Settings → Tint) and a lit rim. Windows' frosted acrylic is still there (Settings → Background), but Windows turns it solid grey while the window is not focused.
- Settings fit the window; the port moved into the note at the bottom.

## Claude Widget 0.2.0

- A new look: lighter glass that lets Windows' acrylic show through, a rim of light, a soft sheen and fine grain; no Claude mark; finer line icons; model names written as "Opus 5.5"; time spent, time left and cost as figures; a new app icon.
- The window updates in place each second, so the pulse, the spinner and the progress bars no longer restart, and Stop stays under the pointer.

## Claude Widget 0.1.0 and widget-bridge 0.1.0

- New: a Windows desktop widget (liquid glass, Claude's clay color) showing every local session: what it does, task-list progress with a time-left estimate, context and usage, a hub of all sessions with Stop, and a notification when a task ends.
- New mod `widget-bridge`: sends each session's status to the widget on 127.0.0.1 after `/widget pair <code>`, and takes its Stop for the running turn only.

## context-gauge 1.1.1

- The usage check shows only the 5-hour, weekly and per-model weekly windows. The answer also carries internal entries (such as `iguana_necktie` at 100%) that are not limits on you; they no longer appear in the band.

## context-gauge 1.1.0

- Usage any time: the 5-hour and weekly windows (and per-model weekly ones such as 7d Opus, where the plan has them) are read from Anthropic when the session starts, on ◉ → ↻ Refresh, and on `/gauge usage`, at most once a minute, with Claude Code's own login held by the host. A reply without limit data no longer clears them. The start check can be turned off in settings.
- The ◉ panel shows status and usage together.
- English README.

## context-gauge 1.0.2

- The model slider and the model name are one control: shown together or hidden together (`/gauge models on|off`; `/gauge slider` does the same).
- Text size holds when room is short: the meters drop their notes, the cost, then the weekly window before they scale down. The picker's pill follows the size too.
- Settings say that text size applies to Classic and Minimal (Terminal draws in the app's own text).

## context-gauge 1.0.1

- The band's controls (model, status, History, settings ⚙) never get pushed out: the meters take the room left and shrink or clip, and leave space for Desktop's button padding.

## context-gauge 1.0.0

First public release.

- **Usage band** above the prompt: context (red near auto-compact), 5-hour and weekly limits with reset countdowns, session cost. Classic (deep colors, SVG), Minimal (quiet SVG) and Terminal (text, always one line) looks; S/M/L text size; follows Claude's theme.
- **While a task runs**: phase timer (thinking / writing / tools), tok/s, the running tool, ■ Stop.
- **Rules**: per-window auto wrap-up (5-hour, weekly) that only arms while a task runs and fires once per window; a /compact rule that reminds or compacts while idle.
- **Model control**: a draggable capsule slider with five editable positions (alias, 1M variant, pinned version or any id), Fable locked until Max is set; an in-band picker with Fast mode and output style.
- **Timeline**: a colored mark and hover card on each of your messages; a History window (≡) with what you asked and what Claude answered, free, plus optional AI one-line summaries (Haiku).
- **Claude status** (◉): status.claude.com, fetched only on Refresh.
- **Settings** in four tabs (Usage, Models, Timeline, Display), and You should know on/off.
- **Cloud and mobile**: `/gauge` text views and a usage line under each answer.

Checks before release: 27 plugin tests (10 consecutive clean runs), type-check with no unused code, `claude plugin validate`, a real-engine run of every `/gauge` command and a tool-using turn with no hook errors in the debug log, and a security pass (outbound calls, command arguments, model-readable text, stored data, secrets scan).
