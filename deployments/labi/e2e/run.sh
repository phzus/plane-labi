#!/usr/bin/env bash
# Labi modification: browser E2E gate for Mensagens (CI only). See LABI-CHANGES.md.
# Brings up a disposable Plane stack on http://localhost with the images under test, seeds throwaway
# accounts, runs Playwright (Chromium) and always tears everything down (`down -v`).
# Needs: LABI_IMAGE_PREFIX (e.g. ghcr.io/phzus/plane-labi) and LABI_TAG (e.g. sha-<commit>).
set -euo pipefail
: "${LABI_IMAGE_PREFIX:?}" "${LABI_TAG:?}"

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
ART="$HERE/artifacts"
rm -rf "$ART" .auth .secrets .env
mkdir -p "$ART/screens"
(umask 077 && mkdir -p .secrets .auth)

rnd() { openssl rand -hex "${1:-24}"; }

# Throwaway secrets for this run only: written with mode 600, never printed, deleted at exit.
(
  umask 077
  cat > .env <<EOF
LABI_IMAGE_PREFIX=${LABI_IMAGE_PREFIX}
LABI_TAG=${LABI_TAG}
SECRET_KEY=$(rnd 32)
LIVE_SERVER_SECRET_KEY=$(rnd 32)
POSTGRES_PASSWORD=$(rnd)
RABBITMQ_PASSWORD=$(rnd)
AWS_ACCESS_KEY_ID=e2e$(rnd 8)
AWS_SECRET_ACCESS_KEY=$(rnd)
EOF
  # role: 20 admin, 15 member, 5 guest. A group needs 2+ other people, hence dani (carla stays outside).
  cat > .secrets/users.json <<EOF
{
  "ana":   {"email": "ana.e2e@example.com",   "first_name": "Ana",   "role": 20, "password": "$(rnd 16)"},
  "bruno": {"email": "bruno.e2e@example.com", "first_name": "Bruno", "role": 15, "password": "$(rnd 16)"},
  "carla": {"email": "carla.e2e@example.com", "first_name": "Carla", "role": 15, "password": "$(rnd 16)"},
  "dani":  {"email": "dani.e2e@example.com",  "first_name": "Dani",  "role": 15, "password": "$(rnd 16)"},
  "gil":   {"email": "gil.e2e@example.com",   "first_name": "Gil",   "role": 5,  "password": "$(rnd 16)"}
}
EOF
)

DC=(docker compose -p labi-e2e -f docker-compose.yml --env-file .env)

cleanup() {
  "${DC[@]}" ps -a > "$ART/compose-ps.txt" 2>&1 || true
  "${DC[@]}" logs --no-color --timestamps > "$ART/compose.log" 2>&1 || true
  "${DC[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
  rm -rf .env .secrets .auth
}
trap cleanup EXIT

echo "::group::Stack up (${LABI_TAG})"
"${DC[@]}" pull -q
"${DC[@]}" up -d
echo "::endgroup::"

wait_http() {
  for _ in $(seq 1 120); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" = "200" ]; then echo "ready: $1"; return 0; fi
    sleep 3
  done
  echo "TIMEOUT waiting for $1" >&2
  return 1
}
migrator_exit="$(docker wait "$("${DC[@]}" ps -aq migrator)")"
[ "$migrator_exit" = "0" ] || { echo "migrator exited with $migrator_exit" >&2; exit 1; }
echo "ready: migrator exit 0"
wait_http http://localhost/api/instances/
wait_http http://localhost/live/health/
wait_http http://localhost/

echo "::group::Seed"
{ printf 'E2E_USERS = %s\n' "$(cat .secrets/users.json)"; cat seed.py; } | "${DC[@]}" exec -T api python manage.py shell
echo "::endgroup::"

# Playwright runs in its official image (browsers + OS deps pinned to the npm version), on the host
# network so http://localhost is the proxy above. Same uid as the runner, so cleanup can delete outputs.
PW_IMAGE="mcr.microsoft.com/playwright:v$(node -p 'require("./package.json").devDependencies["@playwright/test"]')-noble"
PW=(docker run --rm --network host --ipc host --user "$(id -u):$(id -g)" -e HOME=/tmp
  -e E2E_USERS_FILE=/e2e/.secrets/users.json -e LABI_IMAGE_PREFIX -e LABI_TAG -v "$HERE:/e2e" -w /e2e "$PW_IMAGE")
echo "::group::Playwright install ($PW_IMAGE)"
docker pull -q "$PW_IMAGE"
"${PW[@]}" npm install --no-audit --no-fund --loglevel=error
echo "::endgroup::"

set +e
"${PW[@]}" npx playwright test
rc=$?
set -e
"${PW[@]}" node summary.mjs || rc=1
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$ART/summary.md" >> "$GITHUB_STEP_SUMMARY" || true
exit "$rc"
