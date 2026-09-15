#!/bin/sh
set -eu

JAVA_HEAP_OPTS="${JAVA_HEAP_OPTS:--Xms256M -Xmx512M}"
trusted_parent_uid=10000

if [ "$(id -u)" -ne "$trusted_parent_uid" ]; then
  echo "mm-ecs-runner must start as the non-root runner-parent user (uid ${trusted_parent_uid})." >&2
  exit 1
fi

exec java ${JAVA_HEAP_OPTS} ${JAVA_OPTS:-} -jar /app/mm-ecs-runner.jar
