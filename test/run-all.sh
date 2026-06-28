#!/usr/bin/env bash
# Drift integration tests. Each suite runs against a FRESH world on an isolated
# port. The isolation matters, learned the hard way:
#   - A stray browser tab left open on :8787 reconnects and sends presence,
#     which pollutes the protocol suite's "sender doesn't receive its own
#     presence" check. Use a port nothing else is pointed at.
#   - Several suites pick "a dormant seed" or "a pre-sprout seed"; after heavy
#     ticking the world saturates at the population cap and none remain, so each
#     suite needs its OWN fresh world (we wipe .wrangler/state per suite).
# Needs .dev.vars with ADMIN_KEY=local-dev-key (see .dev.vars.example). The dev
# world is kept SMALL via .dev.vars SEED_N so each suite's ticks are fast; prod
# (no SEED_N) seeds the full grove world.
#
# EVERY suite is run under a hard per-suite timeout (SUITE_TIMEOUT, default 75s):
# a wedged worker/test is killed and counted as a failure instead of hanging the
# whole run forever (learned the hard way — a single hung suite once ran for hours).
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8799}
LOG=/tmp/drift-test-worker.log
SUITE_TIMEOUT=${SUITE_TIMEOUT:-75}

# Run `node <file>` with a hard wall-clock cap (portable — macOS has no `timeout`).
# Returns the test's exit code, or 124 if it was killed for exceeding the cap.
run_node() {
  local f="$1"
  PORT="$PORT" node "$f" &
  local pid=$!
  ( sleep "$SUITE_TIMEOUT"; kill -9 "$pid" 2>/dev/null ) &
  local killer=$!
  wait "$pid" 2>/dev/null; local rc=$?
  kill -9 "$killer" 2>/dev/null; wait "$killer" 2>/dev/null || true
  if [ "$rc" -ge 128 ]; then echo "  !! TIMEOUT — killed after ${SUITE_TIMEOUT}s"; return 124; fi
  return "$rc"
}

boot() {
  pkill -9 -f "wrangler dev" 2>/dev/null || true
  pkill -9 -f workerd 2>/dev/null || true
  # wrangler dev spawns long-lived `esbuild --service` children that ORPHAN when
  # wrangler is SIGKILLed — kill them too, or they pile up across suites/runs and
  # peg the CPU (dozens of idle esbuild @ ~1-2% each). Scoped to this project.
  pkill -9 -f "$PWD/node_modules/@esbuild" 2>/dev/null || true
  sleep 3
  rm -rf .wrangler/state
  WRANGLER_SEND_METRICS=false npx wrangler dev --port "$PORT" --ip 127.0.0.1 > "$LOG" 2>&1 &
  for _ in $(seq 1 40); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null)" = "200" ]; then
      # also confirm the Durable Object serves a WS world_state (HTTP 200 alone is too early)
      if PORT="$PORT" node -e "const ws=new WebSocket('ws://127.0.0.1:'+process.env.PORT+'/ws');ws.addEventListener('message',e=>{if(JSON.parse(e.data).t==='world_state'){ws.close();process.exit(0);}});ws.addEventListener('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000);" 2>/dev/null; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "worker never came up on :$PORT"; tail -8 "$LOG"; exit 1
}

fail=0

# Pure unit suites — no worker boot needed.
for unit in cull audio-map physics creatures seed; do
  echo "=== $unit (unit) ==="
  run_node "test/$unit.test.mjs" || fail=1
done

# Integration suites — each against a FRESH worker on an isolated port.
for suite in protocol interest grid checkpoint decouple growth seasons anomalies water-crystals stones water-flow thermal ceiling creature-world creature-social; do
  boot
  echo "=== $suite ==="
  run_node "test/$suite.test.mjs" || fail=1
done
pkill -9 -f "wrangler dev" 2>/dev/null || true
pkill -9 -f workerd 2>/dev/null || true
pkill -9 -f "$PWD/node_modules/@esbuild" 2>/dev/null || true # don't leave orphaned esbuild services behind
[ "$fail" = 0 ] && echo "ALL SUITES PASSED" || { echo "SOME SUITES FAILED"; exit 1; }
