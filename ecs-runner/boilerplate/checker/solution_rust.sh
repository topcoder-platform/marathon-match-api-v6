#!/bin/sh
NAME=$1
TIMEOUT=$2
COMPILE_TIMEOUT=$3

timeout ${COMPILE_TIMEOUT}s rustc --edition=2024 -O /workdir/${NAME}.rs -o /workdir/${NAME}
echo "timeout ${TIMEOUT}s env RUST_BACKTRACE=1 /workdir/${NAME}" > /workdir/command.txt
