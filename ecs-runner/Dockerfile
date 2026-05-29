# syntax=docker/dockerfile:1.7

# Build stage
FROM maven:3.9.9-eclipse-temurin-8 AS builder
WORKDIR /workspace
COPY pom.xml /workspace/pom.xml
COPY boilerplate/src/ /workspace/src/
COPY src/ /workspace/src/
RUN mvn -B -ntp clean package -DskipTests

# Runtime stage
FROM eclipse-temurin:8-jdk-noble

ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_TOOLCHAIN=stable
ENV PATH=/usr/local/cargo/bin:${PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        dotnet-sdk-10.0 \
        findutils \
        g++-14 \
        gcc-14 \
        gzip \
        mono-devel \
        procps \
        python3 \
        unzip \
        wget \
        zip \
    && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-14 140 \
    && update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-14 140 \
    && update-alternatives --install /usr/bin/cc cc /usr/bin/gcc-14 140 \
    && rm -rf /var/lib/apt/lists/* \
    && dotnet --info >/dev/null \
    && wget -qO- https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path \
    && chmod -R a+rX "${RUSTUP_HOME}" "${CARGO_HOME}" \
    && rustc --version >/dev/null

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin runner
WORKDIR /app

COPY --from=builder /workspace/target/mm-ecs-runner-1.0.0.jar /app/mm-ecs-runner.jar
COPY scripts/ /app/scripts/
RUN gcc -O2 -Wall -Wextra -o /usr/local/bin/mm-net-isolate /app/scripts/mm-net-isolate.c \
    && chmod +x /app/scripts/*.sh /usr/local/bin/mm-net-isolate

ENV DOTNET_ROOT=/usr/lib/dotnet
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
ENV DOTNET_NOLOGO=1
ENV JAVA_TOOL_OPTIONS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0 -Djava.awt.headless=true -Dfile.encoding=UTF-8"

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
