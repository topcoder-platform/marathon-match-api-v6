#!/bin/sh
set -eu
# Run inside the built image as its default runner-parent user.
test "$(id -u)" = 10000
work_dir=$(mktemp -d /tmp/mm-language-harness-XXXXXX)
javac -d "$work_dir" /app/scripts/RunnerLanguageSmoke.java
java -cp "$work_dir:/app/mm-ecs-runner.jar" RunnerLanguageSmoke
