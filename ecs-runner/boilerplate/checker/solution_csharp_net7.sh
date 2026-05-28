#!/bin/sh
NAME=$1
TIMEOUT=$2
COMPILE_TIMEOUT=$3

./solution_csharp_dotnet.sh ${NAME} ${TIMEOUT} ${COMPILE_TIMEOUT} cs_net7
