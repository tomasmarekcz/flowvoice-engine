#!/usr/bin/env bash
# Sourced by deploy-engine.sh and deploy-frontend.sh (the same file lives in both repos) — LEA-80.
# Refuses to deploy while anything that a restart would interrupt is running: calls (live, wrapping up,
# ringing the owner, test calls), the AI preparation after sign-up, document processing.
#
#   wait_for_idle <wait_minutes> <force 0|1>
#     returns 0 when it is safe to continue, 1 when something is still running after the waiting time.
#     Checks once a minute while waiting. force=1 continues anyway (only for a broken production).

ACTIVITY_ENV_FILE="${ACTIVITY_ENV_FILE:-$HOME/flowvoice-engine/.env}"
ACTIVITY_DASHBOARD_URL="${ACTIVITY_DASHBOARD_URL:-http://localhost:3000}"
ACTIVITY_ENGINE_URL="${ACTIVITY_ENGINE_URL:-http://localhost:8080}"
ACTIVITY_POLL_SECONDS="${ACTIVITY_POLL_SECONDS:-60}"

_activity_secret() {
  grep -E '^ENGINE_INTERNAL_SECRET=' "$ACTIVITY_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-
}

# Prints "<http_code>" on the first line and the body after it. A connection error gives 000.
_get() {
  local url="$1" secret="$2" out
  out="$(curl -sS -m 8 -w '\n%{http_code}' -H "X-Internal-Secret: $secret" "$url" 2>/dev/null)" || { echo "000"; return; }
  echo "${out##*$'\n'}"
  echo "${out%$'\n'*}"
}

# Sets ACTIVITY_BLOCKING (0/1) and ACTIVITY_SUMMARY (text).
check_activity() {
  local secret code body
  secret="$(_activity_secret)"
  ACTIVITY_BLOCKING=0
  ACTIVITY_SUMMARY=""

  # 1) The dashboard sums up everything (engine + database).
  { read -r code; body="$(cat)"; } < <(_get "$ACTIVITY_DASHBOARD_URL/api/internal/activity" "$secret")
  if [[ "$code" == "200" ]]; then
    ACTIVITY_BLOCKING="$(printf '%s' "$body" | python3 -c 'import sys,json; print(1 if json.load(sys.stdin).get("blocking") else 0)' 2>/dev/null || echo 0)"
    ACTIVITY_SUMMARY="$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("summary",""))' 2>/dev/null)"
    return
  fi

  # 2) Dashboard is down or too old: ask the engine directly (calls only).
  { read -r code; body="$(cat)"; } < <(_get "$ACTIVITY_ENGINE_URL/internal/active-calls" "$secret")
  if [[ "$code" == "200" ]]; then
    local n
    n="$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("active",0))' 2>/dev/null || echo 0)"
    if [[ "$n" -gt 0 ]]; then ACTIVITY_BLOCKING=1; ACTIVITY_SUMMARY="běží $n hovorů (jen engine, dashboard neodpovídá)"; fi
    return
  fi

  # 3) Neither answers: an old version that cannot report, or a service that is down. Nothing we can see.
  ACTIVITY_SUMMARY="aktivitu nelze zjistit (starší verze bez hlášení nebo služba neběží), zkontroluj ručně"
  echo "UPOZORNĚNÍ: $ACTIVITY_SUMMARY"
}

wait_for_idle() {
  local wait_minutes="${1:-0}" force="${2:-0}" deadline
  deadline=$(( $(date +%s) + wait_minutes * 60 ))
  while true; do
    check_activity
    if [[ "$ACTIVITY_BLOCKING" == "0" ]]; then
      echo "Žádný hovor ani akce neběží, lze nasadit."
      return 0
    fi
    echo "Právě běží: $ACTIVITY_SUMMARY"
    if [[ "$force" == "1" ]]; then
      echo "VYNUCENO: nasazuji i přes běžící aktivitu."
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      echo "Nasazení se NESPUSTILO, protože něco běží: $ACTIVITY_SUMMARY"
      echo "Spusť workflow znovu, až bude volno (vidíš to v Adminu), nebo nastav čekání (wait_minutes)."
      return 1
    fi
    echo "Zkontroluji znovu za minutu…"
    sleep "$ACTIVITY_POLL_SECONDS"
  done
}
