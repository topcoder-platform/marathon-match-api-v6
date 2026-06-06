#!/bin/sh
NAME=$1
TIMEOUT=$2
COMPILE_TIMEOUT=$3
SOURCE_EXTENSION=$4

if test -z "${SOURCE_EXTENSION}"; then
  if test -f /workdir/${NAME}.cs_net10; then
    SOURCE_EXTENSION=cs_net10
  else
    SOURCE_EXTENSION=cs_net7
  fi
fi

if test "${SOURCE_EXTENSION}" = "cs_net7"; then
  TARGET_FRAMEWORK=net7.0
elif test "${SOURCE_EXTENSION}" = "cs_net10"; then
  TARGET_FRAMEWORK=net10.0
else
  echo "Unsupported .NET C# source extension: ${SOURCE_EXTENSION}"
  exit 1
fi

echo '<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>'${TARGET_FRAMEWORK}'</TargetFramework>
    <OutputType>Exe</OutputType>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
</Project>' > ${NAME}.csproj
cp /workdir/${NAME}.${SOURCE_EXTENSION} ${NAME}.cs

timeout ${COMPILE_TIMEOUT}s dotnet publish ${NAME}.csproj -c Release -o /workdir/${NAME}

echo "timeout ${TIMEOUT}s /workdir/${NAME}/${NAME}" > /workdir/command.txt
