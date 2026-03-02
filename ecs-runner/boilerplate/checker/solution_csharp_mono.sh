#!/bin/sh
NAME=$1
TIMEOUT=$2
COMPILE_TIMEOUT=$3

timeout ${COMPILE_TIMEOUT}s mcs /workdir/${NAME}.cs /r:System.Numerics.dll /out:/workdir/${NAME}.exe
echo "timeout ${TIMEOUT}s mono /workdir/${NAME}.exe" > /workdir/command.txt
