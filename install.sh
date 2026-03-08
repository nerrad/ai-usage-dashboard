#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$HOME/.claude/hooks"
LAUNCHAGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_LABEL="com.ai-usage-dashboard.codex-tracker"
PLIST_PATH="$LAUNCHAGENTS_DIR/$PLIST_LABEL.plist"
LOG_DIR="$HOME/.claude/logs"

echo "AI Usage Dashboard — install"
echo "============================="
echo ""

# --- 1. Symlink hooks ---
mkdir -p "$HOOKS_DIR"

echo "[1/3] Symlinking hooks into $HOOKS_DIR"

for hook in session-tracker.js codex-session-tracker.py; do
  src="$SCRIPT_DIR/hooks/$hook"
  dst="$HOOKS_DIR/$hook"
  if [ -L "$dst" ]; then
    echo "  $hook: symlink already exists, updating"
    rm "$dst"
  elif [ -f "$dst" ]; then
    echo "  $hook: backing up existing file to $dst.bak"
    mv "$dst" "$dst.bak"
  fi
  ln -s "$src" "$dst"
  echo "  $hook: linked"
done

# --- 2. Claude Code hook config hint ---
echo ""
echo "[2/3] Claude Code SessionEnd hook"

SETTINGS_FILE="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_FILE" ] && grep -q "session-tracker.js" "$SETTINGS_FILE"; then
  echo "  Already configured in $SETTINGS_FILE"
else
  echo "  Add this to your ~/.claude/settings.json hooks.SessionEnd:"
  echo ""
  echo '    "SessionEnd": [{'
  echo '      "matcher": "",'
  echo '      "hooks": [{'
  echo '        "type": "command",'
  echo '        "command": "~/.claude/hooks/session-tracker.js"'
  echo '      }]'
  echo '    }]'
  echo ""
fi

# --- 3. Codex launchd agent (macOS only) ---
echo "[3/3] Codex session tracker (launchd)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "  Skipping — not macOS. Run hooks/codex-session-tracker.py via cron instead:"
  echo "    */10 * * * * /usr/bin/python3 $SCRIPT_DIR/hooks/codex-session-tracker.py"
else
  mkdir -p "$LAUNCHAGENTS_DIR" "$LOG_DIR"

  # Unload old plist if running
  if launchctl list "$PLIST_LABEL" &>/dev/null; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi
  # Also unload legacy label if present
  if launchctl list "com.dethier.codex-session-tracker" &>/dev/null; then
    launchctl unload "$LAUNCHAGENTS_DIR/com.dethier.codex-session-tracker.plist" 2>/dev/null || true
    echo "  Unloaded legacy com.dethier.codex-session-tracker agent"
  fi

  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$PLIST_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/python3</string>
		<string>$HOOKS_DIR/codex-session-tracker.py</string>
	</array>
	<key>StartInterval</key>
	<integer>600</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$LOG_DIR/codex-tracker.log</string>
	<key>StandardErrorPath</key>
	<string>$LOG_DIR/codex-tracker.log</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>Nice</key>
	<integer>10</integer>
</dict>
</plist>
PLIST

  launchctl load "$PLIST_PATH"
  echo "  Installed and loaded $PLIST_LABEL"
fi

# --- Done ---
echo ""
echo "Done. Add this to your ~/.zshrc:"
echo "  source $SCRIPT_DIR/init.sh"
echo ""
echo "Then run: ai-dashboard"
