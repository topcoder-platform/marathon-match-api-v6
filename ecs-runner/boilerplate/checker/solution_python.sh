#!/bin/sh
NAME=$1
TIMEOUT=$2
COMPILE_TIMEOUT=$3

python3.6 -c '1+1' > /dev/null
echo "timeout ${TIMEOUT}s python3.6 /workdir/${NAME}.py" > /workdir/command.txt
