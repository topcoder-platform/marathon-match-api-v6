#!/bin/sh
set -eu

JAVA_HEAP_OPTS="${JAVA_HEAP_OPTS:--Xms256M -Xmx512M}"

if [ "$(id -u)" -ne 0 ]; then
  echo "mm-ecs-runner must start as root so isolated execution can drop to the runner user." >&2
  exit 1
fi

exec java ${JAVA_HEAP_OPTS} ${JAVA_OPTS:-} -jar /app/mm-ecs-runner.jar
