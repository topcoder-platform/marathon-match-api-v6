#!/bin/sh
set -eu

JAVA_HEAP_OPTS="${JAVA_HEAP_OPTS:--Xms256M -Xmx512M}"

if [ "$(id -u)" -ne 0 ]; then
  echo "mm-ecs-runner must start as root so the isolated scorer helper can drop submissions to the scorer user." >&2
  exit 1
fi

exec java ${JAVA_HEAP_OPTS} ${JAVA_OPTS:-} -jar /app/mm-ecs-runner.jar
