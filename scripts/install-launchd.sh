#!/usr/bin/env bash
# Installs two per-user launchd agents so the backend survives logout-less reboots of the session:
#   - ai.friday.engine : `bun run start` in the repo (Bun reads .env from the repo root)
#   - ai.friday.tunnel : `cloudflared tunnel run <TUNNEL>` (uses ~/.cloudflared/config.yml)
# Usage: scripts/install-launchd.sh [install|uninstall|status]   (TUNNEL env var, default: friday)
#        scripts/install-launchd.sh start|stop [engine|tunnel]    (default: both)
#        scripts/install-launchd.sh restart [engine|tunnel]       (default: engine, to load new code)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
TUNNEL="${TUNNEL:-friday}"
BUN="$(command -v bun)"
CLOUDFLARED="$(command -v cloudflared)"
# AGENT_HOME from .env decides where launchd logs go (a failed start is also in $AGENT_HOME/logs).
AGENT_HOME="$(sed -n 's/^AGENT_HOME=//p' "$REPO/.env" | head -1)"
LOGS="${AGENT_HOME:?AGENT_HOME missing in .env}/logs"
LABELS=(ai.friday.engine ai.friday.tunnel)

# plist <label> <workdir> <program args...>
plist() {
  local label="$1" workdir="$2"; shift 2
  local args=""
  for a in "$@"; do args+="    <string>$a</string>"$'\n'; done
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
$args  </array>
  <key>WorkingDirectory</key><string>$workdir</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$BUN"):$(dirname "$CLOUDFLARED"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/$label.out.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$label.err.log</string>
</dict></plist>
EOF
}

# pick <engine|tunnel|""> <default when empty>: sets TARGETS to the agent labels a command acts on.
# (An array set here, not printed: an `exit` inside $(...) would only leave the subshell.)
pick() {
  case "${1:-$2}" in
    engine) TARGETS=(ai.friday.engine) ;;
    tunnel) TARGETS=(ai.friday.tunnel) ;;
    all) TARGETS=("${LABELS[@]}") ;;
    *) echo "unknown target: $1 (engine|tunnel)" >&2; exit 2 ;;
  esac
}
loaded() { launchctl print "gui/$UID/$1" >/dev/null 2>&1; }

case "${1:-install}" in
  install)
    mkdir -p "$AGENTS" "$LOGS"
    plist ai.friday.engine "$REPO" "$BUN" run start > "$AGENTS/ai.friday.engine.plist"
    plist ai.friday.tunnel "$HOME" "$CLOUDFLARED" tunnel run "$TUNNEL" > "$AGENTS/ai.friday.tunnel.plist"
    for l in "${LABELS[@]}"; do
      launchctl bootout "gui/$UID/$l" 2>/dev/null || true
      launchctl bootstrap "gui/$UID" "$AGENTS/$l.plist"
    done
    ;;
  uninstall)
    for l in "${LABELS[@]}"; do
      launchctl bootout "gui/$UID/$l" 2>/dev/null || true
      rm -f "$AGENTS/$l.plist"
    done
    ;;
  start)
    # Loads a stopped agent from its plist; an already loaded one is started if it is not running.
    pick "${2:-}" all
    for l in "${TARGETS[@]}"; do
      [[ -f "$AGENTS/$l.plist" ]] || { echo "$l: not installed, run: $0 install" >&2; exit 1; }
      if loaded "$l"; then launchctl kickstart "gui/$UID/$l"; else launchctl bootstrap "gui/$UID" "$AGENTS/$l.plist"; fi
      echo "$l: started"
    done
    ;;
  stop)
    # Unloads the agent (launchd sends SIGTERM, so runs settle); KeepAlive no longer restarts it until `start`.
    pick "${2:-}" all
    for l in "${TARGETS[@]}"; do
      launchctl bootout "gui/$UID/$l" 2>/dev/null || true
      echo "$l: stopped"
    done
    ;;
  restart)
    # SIGTERM stops it cleanly and KeepAlive starts it again with the new code (about 10 s, ThrottleInterval).
    pick "${2:-}" engine
    for l in "${TARGETS[@]}"; do
      if loaded "$l"; then launchctl kill SIGTERM "gui/$UID/$l"; else launchctl bootstrap "gui/$UID" "$AGENTS/$l.plist"; fi
      echo "$l: restarting"
    done
    ;;
  status)
    for l in "${LABELS[@]}"; do launchctl print "gui/$UID/$l" 2>/dev/null | rg -m3 'state|pid|last exit' || echo "$l: not loaded"; done
    ;;
  *) echo "usage: $0 [install|uninstall|status|start|stop|restart] [engine|tunnel]" >&2; exit 2 ;;
esac
