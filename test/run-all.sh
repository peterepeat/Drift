#!/usr/bin/env bash
# Drift integration tests. Each suite runs against a FRESH world on an isolated
# port. The isolation matters, learned the hard way:
#   - A stray browser tab left open on :8787 reconnects and sends presence,
#     which pollutes the protocol suite's "sender doesn't receive its own
#     presence" check. Use a port nothing else is pointed at.
#   - Several suites pick "a dormant seed" or "a pre-sprout seed"; after heavy
#     ticking the world saturates at the population cap and none remain, so each
#     suite needs its OWN fresh world (we wipe .wrangler/state per suite).
# Needs .dev.vars with ADMIN_KEY=local-dev-key (see .dev.vars.example).
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8799}
LOG=/tmp/drift-test-worker.log

boot() {
  pkill -9 -f "wrangler dev" 2>/dev/null || true
  pkill -9 -f workerd 2>/dev/null || true
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
for suite in protocol growth seasons anomalies water-crystals; do
  boot
  echo "=== $suite ==="
  PORT="$PORT" node "test/$suite.test.mjs" || fail=1
done
pkill -9 -f "wrangler dev" 2>/dev/null || true
[ "$fail" = 0 ] && echo "ALL SUITES PASSED" || { echo "SOME SUITES FAILED"; exit 1; }
