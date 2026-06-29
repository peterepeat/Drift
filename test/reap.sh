#!/usr/bin/env bash
# Reap every dev/build process THIS project spawned — `wrangler dev` workers and their
# `workerd` + `esbuild --service` children — including orphans (PPID 1) left by a
# crashed or interrupted run. Safe to run anytime: `npm run reap` or `bash test/reap.sh`.
#
# ── WHY THIS EXISTS (the bug it guards against) ──────────────────────────────────────
# `wrangler dev` is launched via `npx`, which spawns the REAL worker
# `node .../wrangler/wrangler-dist/cli.js dev`. Two cleanup mistakes used to leave that
# worker (and its workerd + esbuild children) running forever, piling up to hundreds of
# processes that pegged the CPU across sessions:
#   1. `pkill -f "wrangler dev"` matches only the `npx wrangler dev` WRAPPER — NOT the
#      worker, whose command line reads "wrangler-dist/cli.js dev". Killing the wrapper
#      ORPHANS the worker (PPID 1), which keeps running.
#   2. `pkill -f "$PWD/node_modules/@esbuild"` never matches from a git WORKTREE: the
#      worktree's $PWD differs from where node_modules actually lives (the MAIN checkout).
# This script fixes both: it targets the real worker command line and resolves the MAIN
# repo root via git, so the patterns match wherever you run it from.
set -u

here="$(cd "$(dirname "$0")/.." && pwd)"
common="$(git -C "$here" rev-parse --git-common-dir 2>/dev/null || echo "$here/.git")"
case "$common" in /*) ;; *) common="$here/$common" ;; esac        # make relative paths absolute
ROOT="$(cd "$(dirname "$common")" 2>/dev/null && pwd || echo "$here")" # MAIN repo root (where node_modules lives)

reaped=0
reap_pat() { # SIGKILL every process whose FULL command line matches $1
  local pids; pids="$(pgrep -f "$1" 2>/dev/null || true)"
  if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null || true; reaped=$((reaped + $(echo "$pids" | wc -w))); fi
}

reap_pat "$ROOT/node_modules/wrangler/wrangler-dist/cli.js dev"  # the actual wrangler dev worker (orphaned or not)
reap_pat "npx wrangler dev"                                      # ...and the npx wrapper, if still alive
reap_pat "$ROOT/node_modules/@esbuild"                            # esbuild --service children (their REAL path)
reap_pat "$ROOT/node_modules/@cloudflare"                         # workerd (the Cloudflare dev runtime binary)

# Port backstop: free the test (8799) and preview (8787) ports if anything still holds them.
for p in "${PORT:-8799}" 8787 8799; do
  pids="$(lsof -ti "tcp:$p" 2>/dev/null || true)"
  if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null || true; reaped=$((reaped + $(echo "$pids" | wc -w))); fi
done

echo "reap: killed ~${reaped} project dev/build process(es)  [root=$ROOT]"
