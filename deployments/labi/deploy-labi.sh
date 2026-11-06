#!/usr/bin/env bash
# Labi modification: production deploy entrypoint. See LABI-CHANGES.md.
# Installed on the server as the *forced command* of a dedicated SSH key, e.g. in authorized_keys:
#   restrict,command="/opt/stacks/plane-labi/deploy-labi.sh" ssh-ed25519 AAAA... github-actions-deploy
# The only accepted input is "deploy sha-<40 hex>". Anything else is refused.
# Steps: lock -> backup -> pull images -> migrate -> recreate app services -> smoke -> rollback on failure.
set -euo pipefail

STACK_DIR="${STACK_DIR:-/opt/stacks/plane-labi}"
IMAGE_PREFIX="${IMAGE_PREFIX:-ghcr.io/phzus/plane-labi}"
DOMAIN="${DOMAIN:-plane.agencialabi.com.br}"
APP_SERVICES=(api worker beat-worker web live)

cmd="${SSH_ORIGINAL_COMMAND:-${1:-}}"
if [[ ! "$cmd" =~ ^deploy\ (sha-[0-9a-f]{40})$ ]]; then
  echo "DEPLOY_REFUSED: invalid command" >&2
  exit 2
fi
TAG="${BASH_REMATCH[1]}"

cd "$STACK_DIR"
exec 9>"$STACK_DIR/.deploy.lock"
flock -n 9 || { echo "DEPLOY_BUSY" >&2; exit 3; }

# compose.yml uses ${LABI_IMAGE_PREFIX:-makeplane/plane}-<frontend|live|backend>:${LABI_TAG:-v1.4.3};
# empty values mean "official upstream images".
prev_tag="$(grep -E '^LABI_TAG=' .env | cut -d= -f2- || true)"
prev_prefix="$(grep -E '^LABI_IMAGE_PREFIX=' .env | cut -d= -f2- || true)"

set_var() {
  if grep -qE "^$1=" .env; then
    sed -i "s#^$1=.*#$1=$2#" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
  chmod 600 .env
}
set_images() { set_var LABI_IMAGE_PREFIX "$1"; set_var LABI_TAG "$2"; }

smoke() {
  local base="https://${DOMAIN}"
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null --resolve "${DOMAIN}:443:127.0.0.1" "${base}/" \
      && curl -fsS -o /dev/null --resolve "${DOMAIN}:443:127.0.0.1" "${base}/api/instances/" \
      && curl -fsS -o /dev/null --resolve "${DOMAIN}:443:127.0.0.1" "${base}/live/health/"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

rollback() {
  echo "DEPLOY_FAILED: rolling back to ${prev_prefix:-makeplane/plane}:${prev_tag:-v1.4.3}" >&2
  set_images "$prev_prefix" "$prev_tag"
  docker compose up -d "${APP_SERVICES[@]}" || true
  exit 1
}

echo "DEPLOY_START $TAG (previous ${prev_prefix:-makeplane/plane}:${prev_tag:-v1.4.3})"

# Registry auth: CI sends its short-lived job token (packages:read) on stdin. It is used from a
# throwaway Docker config that is deleted on exit, so no credential is stored on the server.
GHCR_TOKEN=""
read -r -t 10 GHCR_TOKEN || true
PULL_CONFIG="$(mktemp -d)"
trap 'rm -rf "$PULL_CONFIG"' EXIT
if [[ -n "$GHCR_TOKEN" ]]; then
  printf '%s' "$GHCR_TOKEN" | DOCKER_CONFIG="$PULL_CONFIG" docker login ghcr.io -u "${GHCR_USER:-phzus}" --password-stdin >/dev/null
fi
unset GHCR_TOKEN

python3 backup.py
for image in frontend live backend; do
  DOCKER_CONFIG="$PULL_CONFIG" docker pull -q "${IMAGE_PREFIX}-${image}:${TAG}"
done

set_images "$IMAGE_PREFIX" "$TAG"
# Migrations run with the new image before any running service is replaced (all Labi migrations are additive).
docker compose run --rm migrator || rollback
docker compose up -d "${APP_SERVICES[@]}" || rollback
smoke || rollback

docker image prune -f >/dev/null 2>&1 || true
echo "DEPLOY_OK $TAG"
