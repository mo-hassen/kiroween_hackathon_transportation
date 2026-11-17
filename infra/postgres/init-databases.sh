#!/bin/sh
# Creates the extra local databases used by tests and by Prisma's shadow database.
# Runs once, when the postgres volume is first initialised. Development only.
set -eu
for db in platform_test platform_shadow; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c "CREATE DATABASE $db OWNER \"$POSTGRES_USER\";"
done
