#!/bin/sh
NAME=$1
TIMEOUT=$2
COMPILE_TIMEOUT=$3

timeout ${COMPILE_TIMEOUT}s kotlinc /workdir/${NAME}.kt -include-runtime -d /workdir/${NAME}.jar
echo "timeout ${TIMEOUT}s java -Xms1G -Xmx1G -jar /workdir/${NAME}.jar" > /workdir/command.txt
