#!/usr/bin/env bash
set -euo pipefail
cd /opt/atendimento/mibro
stamp="pre-bots-v03413-$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p backups
docker exec mibro-atendimento-database-1 sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "backups/$stamp.dump"
test -s "backups/$stamp.dump"
docker exec mibro-atendimento-database-1 pg_restore -l "/backups/$stamp.dump" > "backups/$stamp.toc.txt"
tar --exclude='./backups' --exclude='./.git' --exclude='./node_modules' -czf "backups/$stamp-source.tar.gz" .
docker exec mibro-atendimento-app-1 tar -C /app/storage -czf - . > "backups/$stamp-media.tar.gz"
tar -tzf "backups/$stamp-source.tar.gz" > /dev/null
tar -tzf "backups/$stamp-media.tar.gz" > /dev/null
git rev-parse HEAD > "backups/$stamp.commit.txt"
docker exec -i mibro-atendimento-database-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL' > "backups/$stamp-counts.txt"
SELECT row_to_json(counts) FROM (SELECT (SELECT count(*) FROM "Contact") AS contacts, (SELECT count(*) FROM "Conversation") AS conversations, (SELECT count(*) FROM "Message") AS messages, (SELECT count(*) FROM "Bot") AS bots) counts;
SQL
(cd backups; sha256sum "$stamp.dump" "$stamp-source.tar.gz" "$stamp-media.tar.gz" "$stamp.commit.txt" "$stamp-counts.txt" > "$stamp.sha256")
printf 'BACKUP_PREFIX=%s\n' "$stamp"
cat "backups/$stamp-counts.txt"
cat "backups/$stamp.sha256"
