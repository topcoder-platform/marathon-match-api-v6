#!/bin/sh
NAME=$1
TIMEOUT=$2
COMPILE_TIMEOUT=$3

timeout ${COMPILE_TIMEOUT}s g++ -std=gnu++23 -O3 /workdir/${NAME}.cpp -o /workdir/${NAME}
echo "timeout ${TIMEOUT}s /workdir/${NAME}" > /workdir/command.txt
