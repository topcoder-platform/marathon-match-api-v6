# syntax=docker/dockerfile:1.7

# Build stage
FROM maven:3.9.9-eclipse-temurin-8 AS builder
WORKDIR /workspace
COPY pom.xml /workspace/pom.xml
COPY boilerplate/src/ /workspace/src/
COPY src/ /workspace/src/
RUN mvn -B -ntp clean package -DskipTests

# Runtime stage
FROM ubuntu:24.04

ARG DOTNET_7_SDK_VERSION=7.0.410
ARG DOTNET_7_SDK_SHA512=20b8e02979328e4c4a14493f7791ed419aabd0175233db80cd60e2c004b829b3e8301281ea86b27ba818372473accf5a6d553e5354c54917c8e84d25f5855caa
ARG DOTNET_7_RUNTIME_VERSION=7.0.20
ARG KOTLIN_VERSION=2.4.10
ARG KOTLIN_COMPILER_SHA256=473dd66c7a3ef4b182065b3da670466c1bf2773a9dbb0ed8b33a39fe9d4f876d

# Standard .kt compilation does not use the main-kts scripting plugin. The
# upstream plugin currently embeds vulnerable plexus-utils 3.4.1, so omit it.
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_TOOLCHAIN=stable
ENV PATH=/usr/local/cargo/bin:${PATH}

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        dotnet-sdk-10.0 \
        findutils \
        g++-14 \
        gcc-14 \
        gzip \
        mono-devel \
        openjdk-17-jdk-headless \
        procps \
        python3 \
        unzip \
        wget \
        zip \
    && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-14 140 \
    && update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-14 140 \
    && update-alternatives --install /usr/bin/cc cc /usr/bin/gcc-14 140 \
    && wget -q "https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_7_SDK_VERSION}/dotnet-sdk-${DOTNET_7_SDK_VERSION}-linux-x64.tar.gz" -O /tmp/dotnet7.tar.gz \
    && echo "${DOTNET_7_SDK_SHA512}  /tmp/dotnet7.tar.gz" | sha512sum --check --strict \
    && mkdir -p /tmp/dotnet7 \
    && tar -xzf /tmp/dotnet7.tar.gz -C /tmp/dotnet7 \
    && for dotnet_path in \
        "host/fxr/${DOTNET_7_RUNTIME_VERSION}" \
        "packs/Microsoft.NETCore.App.Host.linux-x64/${DOTNET_7_RUNTIME_VERSION}" \
        "packs/Microsoft.NETCore.App.Ref/${DOTNET_7_RUNTIME_VERSION}" \
        "shared/Microsoft.NETCore.App/${DOTNET_7_RUNTIME_VERSION}"; do \
        mkdir -p "/usr/lib/dotnet/$(dirname "${dotnet_path}")"; \
        cp -a "/tmp/dotnet7/${dotnet_path}" "/usr/lib/dotnet/${dotnet_path}"; \
    done \
    && wget -q "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip" -O /tmp/kotlin-compiler.zip \
    && echo "${KOTLIN_COMPILER_SHA256}  /tmp/kotlin-compiler.zip" | sha256sum --check --strict \
    && unzip -q /tmp/kotlin-compiler.zip -d /opt \
    && ln -s /opt/kotlinc/bin/kotlinc /usr/local/bin/kotlinc \
    && rm -rf /tmp/dotnet7 /tmp/dotnet7.tar.gz /tmp/kotlin-compiler.zip \
    && rm -rf /var/lib/apt/lists/* \
    && java -version >/dev/null \
    && dotnet --info >/dev/null \
    && wget -qO- https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path \
    && chmod -R a+rX "${RUSTUP_HOME}" "${CARGO_HOME}" \
    && kotlinc -version >/dev/null \
    && rustc --version >/dev/null

RUN rm /opt/kotlinc/lib/kotlin-main-kts.jar

RUN groupadd --gid 10001 runner \
    && useradd --create-home --uid 10000 --gid runner --shell /usr/sbin/nologin runner-parent \
    && useradd --create-home --uid 10001 --gid runner --shell /usr/sbin/nologin runner \
    && groupadd --gid 10002 scorer \
    && useradd --create-home --uid 10002 --gid scorer --shell /usr/sbin/nologin scorer
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
