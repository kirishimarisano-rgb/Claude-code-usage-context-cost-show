# Changelog

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
