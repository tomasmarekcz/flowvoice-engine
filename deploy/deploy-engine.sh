#!/usr/bin/env bash
# Runs ON the server. Usage:
#   deploy-engine.sh <sha> <image.tar.gz>   load + start a new engine version
#   deploy-engine.sh --rollback             go back to the previous version
set -euo pipefail

STATE_DIR="$HOME/deploy"
ENV_FILE="$HOME/flowvoice-engine/.env"
IMAGE="flowvoice-engine"
mkdir -p "$STATE_DIR"

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

if [[ "${1:-}" == "--rollback" ]]; then
  prev="$(cat "$STATE_DIR/engine.previous" 2>/dev/null || true)"
  [[ -n "$prev" ]] || { echo "No previous version recorded"; exit 1; }
  run_container "$prev"
  health_ok || { echo "Rollback health check FAILED"; exit 1; }
  cp "$STATE_DIR/engine.previous" "$STATE_DIR/engine.current"
  echo "Rolled back to $prev"
  exit 0
fi

sha="${1:?usage: deploy-engine.sh <sha> <image.tar.gz>}"
tarball="${2:?usage: deploy-engine.sh <sha> <image.tar.gz>}"

# The image is tagged flowvoice-engine:<sha> when it is built in CI.
gunzip -c "$tarball" | docker load

current="$(cat "$STATE_DIR/engine.current" 2>/dev/null || true)"

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
