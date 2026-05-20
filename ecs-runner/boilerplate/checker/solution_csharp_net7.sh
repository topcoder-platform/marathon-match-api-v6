#!/bin/sh
NAME=$1
TIMEOUT=$2
COMPILE_TIMEOUT=$3

echo '<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net7.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
</Project>' > ${NAME}.csproj
cp ${NAME}.cs_net7 ${NAME}.cs

timeout ${COMPILE_TIMEOUT}s dotnet publish ${NAME}.csproj -c Release -o /workdir/${NAME}

echo "timeout ${TIMEOUT}s /workdir/${NAME}/${NAME}" > /workdir/command.txt

