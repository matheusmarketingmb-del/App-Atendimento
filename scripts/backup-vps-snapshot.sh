#!/usr/bin/env bash
# Executar na VPS. Artefatos privados: nunca versionar a pasta resultante.
set -euo pipefail
umask 077
project=/opt/atendimento/mibro
backup=/opt/atendimento/backups/full-pre-local-git-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$backup"
chmod 700 "$backup"
cd "$project"
docker exec mibro-atendimento-database-1 sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
docker exec mibro-atendimento-database-1 sh -c 'exec pg_dumpall -U "$POSTGRES_USER" --globals-only' > "$backup/database-globals.sql"
test -s "$backup/database.dump"
docker exec -i mibro-atendimento-database-1 pg_restore --list < "$backup/database.dump" > "$backup/database.toc.txt"
tar --exclude='./backups' --exclude='./node_modules' --exclude='./storage' -czf "$backup/server-files.tar.gz" .
docker exec mibro-atendimento-app-1 tar -C /app/storage -czf - . > "$backup/media.tar.gz"
docker inspect mibro-atendimento-app-1 mibro-atendimento-database-1 > "$backup/containers.private.json"
docker compose -f compose.vps.yml config > "$backup/compose.private.yml"
image_id=$(docker inspect --format '{{.Image}}' mibro-atendimento-app-1)
docker image save "$image_id" | gzip > "$backup/app-image.tar.gz"
git rev-parse HEAD > "$backup/vps-commit.txt"
git status --short > "$backup/vps-working-tree.txt"
git diff --binary HEAD > "$backup/vps-working-tree.patch"
date -u +%FT%TZ > "$backup/completed-utc.txt"
for archive in server-files.tar.gz media.tar.gz app-image.tar.gz; do gzip -t "$backup/$archive"; done
tar -tzf "$backup/server-files.tar.gz" > "$backup/server-files.list.txt"
tar -tzf "$backup/media.tar.gz" > "$backup/media.list.txt"
chmod 600 "$backup"/*
(cd "$backup"; sha256sum database.dump database-globals.sql server-files.tar.gz media.tar.gz app-image.tar.gz containers.private.json compose.private.yml vps-commit.txt vps-working-tree.patch > SHA256SUMS; sha256sum -c SHA256SUMS)
printf 'BACKUP_PATH=%s\n' "$backup"
du -sh "$backup"
