#!/bin/sh

java -Xms512M -Xmx512M -jar /app/mm-ecs-runner.jar
EXIT_CODE=$?

exit $EXIT_CODE
