# syntax=docker/dockerfile:1.7

# Build stage
FROM maven:3.9.9-eclipse-temurin-8 AS builder
WORKDIR /workspace
COPY pom.xml /workspace/pom.xml
COPY boilerplate/src/ /workspace/src/
COPY src/ /workspace/src/
RUN mvn -B -ntp clean package -DskipTests

# Runtime stage
FROM eclipse-temurin:8-jre-jammy

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        findutils \
        g++ \
        gzip \
        libicu70 \
        mono-devel \
        procps \
        python3 \
        unzip \
        wget \
        zip \
    && rm -rf /var/lib/apt/lists/* \
    && wget -q https://dot.net/v1/dotnet-install.sh -O /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 7.0 --install-dir /usr/share/dotnet \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
    && rm -f /tmp/dotnet-install.sh

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin runner
WORKDIR /app

COPY --from=builder /workspace/target/mm-ecs-runner-1.0.0.jar /app/mm-ecs-runner.jar
COPY scripts/ /app/scripts/
RUN gcc -O2 -Wall -Wextra -o /usr/local/bin/mm-net-isolate /app/scripts/mm-net-isolate.c \
    && chmod +x /app/scripts/*.sh /usr/local/bin/mm-net-isolate

ENV DOTNET_ROOT=/usr/share/dotnet
ENV JAVA_TOOL_OPTIONS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0 -Djava.awt.headless=true -Dfile.encoding=UTF-8"

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
