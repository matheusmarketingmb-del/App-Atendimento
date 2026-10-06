#!/usr/bin/env bash
set -euo pipefail
cd /opt/atendimento/mibro
test "$(git rev-parse HEAD)" = "ab09aabed25ec0d01e066a515e65a92c4af98eca"
test -z "$(git status --porcelain --untracked-files=no)"
git apply --check /tmp/bots-v03413-followup.patch
docker image tag "$(docker inspect mibro-atendimento-app-1 --format '{{.Image}}')" mibro-atendimento-app:v03413-initial
git am /tmp/bots-v03413-followup.patch
docker compose -f compose.vps.yml build app
docker compose -f compose.vps.yml up -d --no-deps app
for attempt in $(seq 1 24); do
  status="$(docker inspect mibro-atendimento-app-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')"
  if [ "$status" = healthy ]; then break; fi
  if [ "$status" = unhealthy ]; then exit 1; fi
  sleep 5
done
test "$(docker inspect mibro-atendimento-app-1 --format '{{.State.Health.Status}}')" = healthy
docker inspect mibro-atendimento-app-1 --format '{{json .Mounts}}' > /tmp/bots-v03413-mounts-final.json
docker inspect mibro-atendimento-database-1 --format '{{.Id}}' > /tmp/bots-v03413-db-final.txt
cmp /tmp/bots-v03413-mounts-before.json /tmp/bots-v03413-mounts-final.json
cmp /tmp/bots-v03413-db-before.txt /tmp/bots-v03413-db-final.txt
docker exec mibro-atendimento-app-1 node -e 'fetch("http://127.0.0.1:3000/health").then(r=>{console.log("HEALTH_HTTP="+r.status);if(!r.ok)process.exit(1)})'
docker exec -i mibro-atendimento-database-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
SELECT row_to_json(counts) FROM (SELECT (SELECT count(*) FROM "Contact") AS contacts, (SELECT count(*) FROM "Conversation") AS conversations, (SELECT count(*) FROM "Message") AS messages, (SELECT count(*) FROM "Bot") AS bots) counts;
SQL
git rev-parse HEAD
git rev-parse HEAD^{tree}
printf 'RELEASE_COMPLETE\n'
