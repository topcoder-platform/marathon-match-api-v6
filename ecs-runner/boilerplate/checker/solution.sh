#!/bin/sh

NAME=$1
TIMEOUT=$2
COMPILE_TIMEOUT=$3

FILE=/workdir/${NAME}

compile_source() {
echo 'Compile start...'

if test -f ${FILE}.cpp; then
./solution_cpp.sh ${NAME} ${TIMEOUT} ${COMPILE_TIMEOUT}
elif test -f ${FILE}.java; then
./solution_java.sh ${NAME} ${TIMEOUT} ${COMPILE_TIMEOUT}
elif test -f ${FILE}.cs; then
./solution_csharp_mono.sh ${NAME} ${TIMEOUT} ${COMPILE_TIMEOUT}
elif test -f ${FILE}.cs_net10; then
./solution_csharp_dotnet.sh ${NAME} ${TIMEOUT} ${COMPILE_TIMEOUT} cs_net10
elif test -f ${FILE}.cs_net7; then
./solution_csharp_dotnet.sh ${NAME} ${TIMEOUT} ${COMPILE_TIMEOUT} cs_net7
elif test -f ${FILE}.py; then
./solution_python.sh ${NAME} ${TIMEOUT} ${COMPILE_TIMEOUT}
elif test -f ${FILE}.rs; then
./solution_rust.sh ${NAME} ${TIMEOUT} ${COMPILE_TIMEOUT}
else 
echo "WARN: No source file. Please make sure that your filename $NAME.[java,cpp,cs,py,rs]"
fi

echo 'Compile end.'
}

compile_source 1>/workdir/artifacts/public/compile_log.txt 2>&1
