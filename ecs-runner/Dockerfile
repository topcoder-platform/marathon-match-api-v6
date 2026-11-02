# syntax=docker/dockerfile:1.7

# Build stage
FROM maven:3.9.9-eclipse-temurin-8 AS builder
WORKDIR /workspace
COPY pom.xml /workspace/pom.xml
COPY boilerplate/src/ /workspace/src/
COPY src/ /workspace/src/
RUN mvn -B -ntp clean package

# Runtime stage
FROM alpine:3.24

# Only reference assemblies are retained for the legacy C# 11 / net7.0 target.
# Execution uses the maintained .NET 10 runtime through explicit roll-forward.
ARG DOTNET_7_SDK_VERSION=7.0.410
ARG DOTNET_7_SDK_SHA512=20b8e02979328e4c4a14493f7791ed419aabd0175233db80cd60e2c004b829b3e8301281ea86b27ba818372473accf5a6d553e5354c54917c8e84d25f5855caa
ARG DOTNET_7_REFERENCE_VERSION=7.0.20
ARG KOTLIN_VERSION=2.4.10
ARG KOTLIN_COMPILER_SHA256=473dd66c7a3ef4b182065b3da670466c1bf2773a9dbb0ed8b33a39fe9d4f876d

RUN apk upgrade --no-cache \
    && apk add --no-cache bash ca-certificates coreutils dotnet10-sdk \
        findutils g++ gcc gzip linux-headers mono mono-dev musl-dev \
        openjdk17-jdk procps python3 rust cargo unzip wget zip \
    && wget -q "https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_7_SDK_VERSION}/dotnet-sdk-${DOTNET_7_SDK_VERSION}-linux-x64.tar.gz" -O /tmp/dotnet7.tar.gz \
    && echo "${DOTNET_7_SDK_SHA512}  /tmp/dotnet7.tar.gz" | sha512sum --check --strict \
    && tar -xzf /tmp/dotnet7.tar.gz -C /usr/lib/dotnet \
        "./packs/Microsoft.NETCore.App.Ref/${DOTNET_7_REFERENCE_VERSION}" \
    && rm /tmp/dotnet7.tar.gz \
    && wget -q "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip" -O /tmp/kotlin-compiler.zip \
    && echo "${KOTLIN_COMPILER_SHA256}  /tmp/kotlin-compiler.zip" | sha256sum --check --strict \
    && unzip -q /tmp/kotlin-compiler.zip -d /opt \
    && ln -s /opt/kotlinc/bin/kotlinc /usr/local/bin/kotlinc \
    && rm /tmp/kotlin-compiler.zip \
    && java -version >/dev/null \
    && dotnet --info >/dev/null \
    && kotlinc -version >/dev/null \
    && rustc --version >/dev/null

# Standard .kt compilation does not use this scripting plugin, which embeds
# vulnerable plexus-utils. Other compiler and language capabilities stay installed.
RUN rm /opt/kotlinc/lib/kotlin-main-kts.jar

RUN addgroup -g 10001 runner \
    && adduser -D -u 10000 -G runner -s /sbin/nologin runner-parent \
    && adduser -D -u 10001 -G runner -s /sbin/nologin runner \
    && addgroup -g 10002 scorer \
    && adduser -D -u 10002 -G scorer -s /sbin/nologin scorer
WORKDIR /app

COPY --chown=runner-parent:runner --from=builder /workspace/target/mm-ecs-runner-1.0.0.jar /app/mm-ecs-runner.jar
COPY --chown=runner-parent:runner scripts/ /app/scripts/
RUN gcc -O2 -Wall -Wextra \
        -DMM_INSTALL_SOCKET_FILTER=0 \
        -DMM_SUPERVISE_CHILD=1 \
        -DMM_DROP_SUPERVISOR_PRIVS=1 \
        -DMM_ISOLATED_UMASK=0007 \
        -o /usr/local/bin/mm-runner-isolate \
        /app/scripts/mm-net-isolate.c \
    && gcc -O2 -Wall -Wextra \
        -DMM_ISOLATED_UID=10002 \
        -DMM_ISOLATED_GID=10002 \
        -DMM_ISOLATED_HOME=\"/home/scorer\" \
        -DMM_ISOLATED_NAME=\"scorer\" \
        -DMM_ENABLE_ADMIN_MODES=1 \
        -DMM_SUPERVISE_CHILD=1 \
        -DMM_DROP_SUPERVISOR_PRIVS=1 \
        -DMM_ENABLE_FS_SANDBOX=1 \
        -o /usr/local/bin/mm-scorer-isolate \
        /app/scripts/mm-net-isolate.c \
    && chown root:runner /usr/local/bin/mm-runner-isolate /usr/local/bin/mm-scorer-isolate \
    && chmod 4750 /usr/local/bin/mm-runner-isolate \
    && chmod 4750 /usr/local/bin/mm-scorer-isolate \
    && chmod +x /app/scripts/*.sh

ENV HOME=/home/runner-parent
ENV DOTNET_ROOT=/usr/lib/dotnet
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
ENV DOTNET_NOLOGO=1
ENV JAVA_TOOL_OPTIONS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0 -Djava.awt.headless=true -Dfile.encoding=UTF-8"

USER runner-parent:runner
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
