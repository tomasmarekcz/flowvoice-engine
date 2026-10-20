#!/usr/bin/env bash
# Runs ON the server. Usage:
#   deploy-engine.sh <sha> <image.tar.gz>   load + start a new engine version
#   deploy-engine.sh --rollback             go back to the previous version
#   deploy-engine.sh --prepare <sha> <image.tar.gz>   only load the image (nothing is restarted)
#   deploy-engine.sh --activate <sha>                 start an already loaded version
# Options (any position): --wait-minutes N (wait for running calls, checking every minute), --force
# (deploy even while something runs). Without them the deploy refuses to run while a call is in progress (LEA-80).
set -euo pipefail

STATE_DIR="$HOME/deploy"
ENV_FILE="$HOME/flowvoice-engine/.env"
IMAGE="flowvoice-engine"
mkdir -p "$STATE_DIR"
source "$STATE_DIR/guard.sh"

# --- options ---
WAIT_MINUTES=0; FORCE=0; MODE="all"; POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait-minutes) WAIT_MINUTES="${2:?--wait-minutes needs a number}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --prepare) MODE="prepare"; shift ;;
    --activate) MODE="activate"; shift ;;
    --rollback) MODE="rollback"; shift ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
[[ "$WAIT_MINUTES" =~ ^[0-9]+$ ]] || { echo "--wait-minutes must be a whole number"; exit 1; }
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

health_ok() {
  for _ in $(seq 1 30); do
    if curl -fsS http://localhost:8080/health >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

run_container() {
  local tag="$1"
  docker stop engine >/dev/null 2>&1 || true
  docker rm engine >/dev/null 2>&1 || true
  docker run -d --restart=always --env-file "$ENV_FILE" --network host --name engine "$IMAGE:$tag" >/dev/null
}

if [[ "$MODE" == "rollback" ]]; then
  wait_for_idle "$WAIT_MINUTES" "$FORCE" || exit 1
  prev="$(cat "$STATE_DIR/engine.previous" 2>/dev/null || true)"
  [[ -n "$prev" ]] || { echo "No previous version recorded"; exit 1; }
  run_container "$prev"
  health_ok || { echo "Rollback health check FAILED"; exit 1; }
  cp "$STATE_DIR/engine.previous" "$STATE_DIR/engine.current"
  echo "Rolled back to $prev"
  exit 0
fi

sha="${1:?usage: deploy-engine.sh <sha> [<image.tar.gz>]}"

if [[ "$MODE" != "activate" ]]; then
  tarball="${2:?usage: deploy-engine.sh <sha> <image.tar.gz>}"
  # The image is tagged flowvoice-engine:<sha> when it is built in CI.
  gunzip -c "$tarball" | docker load
  [[ "$MODE" == "prepare" ]] && { echo "Image $sha loaded, not started"; exit 0; }
else
  docker image inspect "$IMAGE:$sha" >/dev/null 2>&1 || { echo "Image $sha is not loaded; run --prepare first"; exit 1; }
fi

current="$(cat "$STATE_DIR/engine.current" 2>/dev/null || true)"

# Last look right before the swap: nothing may be running (LEA-80).
wait_for_idle "$WAIT_MINUTES" "$FORCE" || exit 1

run_container "$sha"
if health_ok; then
  # state is only recorded after success, so a failed deploy never loses the real previous version
  [[ -n "$current" && "$current" != "$sha" ]] && echo "$current" > "$STATE_DIR/engine.previous"
  echo "$sha" > "$STATE_DIR/engine.current"
  # keep the 3 newest tagged images, prune the rest (also frees disk)
  docker images "$IMAGE" --format '{{.Tag}}' | grep -v -e latest -e '<none>' | tail -n +4 | xargs -r -I{} docker rmi "$IMAGE:{}" || true
  docker image prune -f >/dev/null
  echo "Engine $sha deployed"
else
  echo "Health check failed for $sha"
  docker logs --tail 50 engine || true
  if [[ -n "$current" ]]; then
    run_container "$current"
    if health_ok; then echo "Rolled back to $current"; else echo "ROLLBACK ALSO FAILED"; fi
  fi
  exit 1
fi
