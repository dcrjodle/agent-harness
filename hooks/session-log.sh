#!/bin/sh
# Claude Code hook (SubagentStart, SubagentStop, PostToolUse on Agent, SessionEnd): bin/session-log
# queues the event for the session log and flushes it in the background. Does nothing without node;
# always exits 0 and prints nothing.
command -v node >/dev/null 2>&1 || exit 0
exec node "$(dirname "$0")/../bin/session-log" hook 2>/dev/null
