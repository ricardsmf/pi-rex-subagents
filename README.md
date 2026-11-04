# pi-rex-subagents

Subagents for [pi](https://github.com/earendil-works/pi), each a `pi` process in a minimized floating
[Rex](https://superlogical.dev/rex) pane in the parent's window. The parent `rex wait`s on the pane in
the background and posts the child's last assistant message back as a new turn.

Tools: `subagent`, `subagent_message`, `subagent_wait`, `subagent_list`. Child sessions live under
`~/.pi/agent/subagents/<parent-session-id>/`.

Requires pi started in a Rex terminal (`REX_SESSION` set) with `rex` on `PATH`; `subagent` fails
outside Rex.

## Agents

Agent definitions are `.md` files with frontmatter, read from this package's `agents/` (none ship), then from
directories other extensions register on
`globalThis[Symbol.for("rex-subagents.agentDirs")]`, then overridden by name from `~/.pi/agent/agents/`.

## Install

```bash
git clone ssh://git@10.9.0.1:2222/ricardsmf/pi-rex-subagents.git ~/projects/pi-rex-subagents
pi install ~/projects/pi-rex-subagents
```

pi loads a local package in place: edits apply on `/reload`.

## Test

```bash
npm test
```

The tests load the extension through the installed `pi`'s own runtime (`PI_PACKAGE_DIR` overrides).
