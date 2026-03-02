# Build stage
FROM maven:3.8-openjdk-8 AS builder
WORKDIR /app
COPY ecs-runner/pom.xml /app/pom.xml
COPY ecs-runner/boilerplate/src/ /app/src/
COPY ecs-runner/src/ /app/src/
RUN mvn clean package -DskipTests

# Runtime stage
FROM openjdk:8u212-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/mm-ecs-runner-1.0.0.jar ./mm-ecs-runner.jar
COPY ecs-runner/scripts/ ./scripts/
RUN chmod +x scripts/*.sh
ENTRYPOINT ["./scripts/entrypoint.sh"]
