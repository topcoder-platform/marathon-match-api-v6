#!/bin/sh
NAME=$1
TIMEOUT=$2
COMPILE_TIMEOUT=$3

timeout ${COMPILE_TIMEOUT}s javac /workdir/${NAME}.java
echo "timeout ${TIMEOUT}s java -Xms1G -Xmx1G -cp /workdir ${NAME}" > /workdir/command.txt
