# syntax=docker/dockerfile:1

# ---- Build stage: compile + package the Spring Boot fat jar ----
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /workspace

# Cache dependencies first (only re-downloads when pom.xml changes).
COPY pom.xml .
RUN mvn -B -q dependency:go-offline

COPY src ./src
RUN mvn -B -q clean package -DskipTests

# ---- Runtime stage: small JRE image running the jar ----
FROM eclipse-temurin:21-jre AS runtime
WORKDIR /app

# Run as a non-root user.
RUN useradd -r -u 1001 appuser
COPY --from=build /workspace/target/procure-copilot-backend-*.jar app.jar
USER appuser

EXPOSE 8080

# The Anthropic key and other config are supplied at runtime via env vars (see README).
# Stub mode stays on unless ANTHROPIC_STUB_MODE=false + a key are provided.
ENV JAVA_OPTS=""
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]
