# AI Usage Dashboard — shell init
# Add to ~/.zshrc (or ~/.bashrc):
#   source /path/to/usage-dashboard/init.sh

_AI_USAGE_DASHBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)"

ai-dashboard() {
  node "$_AI_USAGE_DASHBOARD_DIR/server.js" "$@"
}

ai-dashboard-backfill() {
  node "$_AI_USAGE_DASHBOARD_DIR/backfill.js" "$@"
}
