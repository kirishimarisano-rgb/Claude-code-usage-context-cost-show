# Changelog

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
