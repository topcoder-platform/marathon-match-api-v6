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
        gzip \
        unzip \
        zip \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin runner
WORKDIR /app

COPY --from=builder /workspace/target/mm-ecs-runner-1.0.0.jar /app/mm-ecs-runner.jar
COPY scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh && chown -R runner:runner /app

ENV JAVA_TOOL_OPTIONS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0 -Djava.awt.headless=true -Dfile.encoding=UTF-8"

USER runner

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
