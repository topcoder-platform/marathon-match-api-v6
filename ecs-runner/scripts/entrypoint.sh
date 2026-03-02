#!/bin/sh
set -eu

JAVA_HEAP_OPTS="${JAVA_HEAP_OPTS:--Xms256M -Xmx512M}"

exec java ${JAVA_HEAP_OPTS} ${JAVA_OPTS:-} -jar /app/mm-ecs-runner.jar
