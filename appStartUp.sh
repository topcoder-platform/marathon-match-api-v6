#!/bin/bash
set -eo pipefail

export DATABASE_URL=$(echo -e ${DATABASE_URL})

# Set default schema to 'marathon_match' if not provided
if [ -z "$POSTGRES_SCHEMA" ]; then
    echo "POSTGRES_SCHEMA not set, defaulting to 'marathon_match'"
    export POSTGRES_SCHEMA="marathon_match"
else
    echo "Using PostgreSQL schema: $POSTGRES_SCHEMA"
fi

echo "Database - running migrations."
if $RESET_DB; then
    echo "Resetting DB"
    node node_modules/prisma/build/index.js migrate reset --force
else
    echo "Bootstrapping DB schema"
    node dist/prisma/migrate.js

    echo "Running migrations"
    node node_modules/prisma/build/index.js migrate deploy
fi

# Start the app
exec node dist/src/main
