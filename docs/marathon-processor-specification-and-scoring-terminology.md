# Marathon Processor Specification and Scoring Terminology

Last verified: May 29, 2026

This article describes how Topcoder Marathon Match submissions are compiled, executed, scored, and reported by the current Marathon Match processor.

The current processor is different from the older EC2-based processor. Marathon Match submissions are scored by an AWS ECS/Fargate runner task. Each scoring task downloads the configured tester, downloads the member submission, runs the tester for the configured seed range, uploads artifacts, and posts score results back to Topcoder services.

## Contents

- Compilation Details
- Processing Server Specifications
- Setup Local Environment Similar to the Runner
- Download and Access Submissions
- Example, Provisional, and System Scores
- Submission Queue and Progress
- Notification Emails
- Scoring Terminology
- Multithreading and Resource Notes

## Compilation Details

The generic ECS runner searches the extracted submission for a supported source file. If a file matching the expected problem solution name exists, that file is preferred. Otherwise, the runner chooses deterministically by supported extension order.

Supported source extensions are:

| Extension | Language / runtime |
| --- | --- |
| `.cpp` | C++ |
| `.java` | Java |
| `.py` | Python 3.12 |
| `.cs` | C# using Mono |
| `.cs_net10` | C# using .NET 10 / C# 14 |
| `.cs_net7` | C# using .NET 10 / C# 14, retained for backward-compatible submission naming |
| `.rs` | Rust latest stable |

The runner normalizes the selected source file into a temporary compile workspace before building or executing it.

### C++

C++ submissions are compiled with `g++` using GNU++23:

```bash
g++ -std=gnu++23 -O3 -march=native Solution.cpp -o Solution
./Solution
```

### Java

Java submissions are compiled and executed with:

```bash
javac Solution.java
java -Xms1G -Xmx1G -cp <workdir> Solution
```

The ECS runner image includes the Java 8 JDK, so Java source submissions can be compiled by the same runner task that executes the tester.

### Python

Python submissions are executed with Python 3.12:

```bash
python3 Solution.py
```

### Rust

Rust submissions use the `.rs` extension and are compiled as a single source file with the latest stable Rust compiler:

```bash
rustc --edition=2024 -O Solution.rs -o Solution
./Solution
```

The ECS runner installs Rust through `rustup` with `RUSTUP_TOOLCHAIN=stable`, so the exact compiler patch version advances when the runner image is rebuilt. As of the verification date above, the stable channel resolves to `rustc 1.96.0`.

### C# with Mono

Mono C# submissions use the `.cs` extension:

```bash
mcs /r:System.Numerics.dll -out:Solution.exe Solution.cs
mono Solution.exe
```

### C# with .NET 10

.NET C# submissions use the special `.cs_net10` extension. The older `.cs_net7` extension remains accepted for backward compatibility, but both extensions are compiled with the .NET 10 SDK and target `net10.0`. The runner creates a temporary project with unsafe blocks enabled, publishes it, and executes the published DLL:

```bash
dotnet publish Solution.csproj -c Release -o Solution
dotnet Solution/Solution.dll
```

### Compile and Test Timeouts

Compile and test timeouts are configured per Marathon Match challenge.

- `compileTimeout` controls submission compilation timeout.
- `testTimeout` controls per-seed tester execution timeout.

The default values supplied by `marathon-match-api-v6` are environment-configurable. If not overridden in service configuration, the API defaults are:

| Setting | Default |
| --- | ---: |
| `testTimeout` | `90000` ms |
| `compileTimeout` | `120000` ms |

## Processing Server Specifications

The current processor runs as an ECS/Fargate task using the configured task definition revision for the challenge scorer. CPU and memory are controlled by that ECS task definition, not by a fixed EC2 instance type.

The current runner image is based on Ubuntu 24.04 Noble and `eclipse-temurin:8-jdk-noble`.

Tool versions verified from a local build of the current runner image:

| Tool | Version |
| --- | --- |
| Operating system | Ubuntu 24.04.4 LTS |
| Java runtime | Temurin OpenJDK 8, `1.8.0_492-b09` |
| Java compiler | `javac 1.8.0_492` |
| GCC | `14.2.0` via `gcc-14` |
| G++ | `14.2.0` via `g++-14` |
| Python | `3.12.3` |
| Mono runtime | `6.8.0.105` |
| Mono C# compiler | `mcs 6.8.0.105` |
| .NET SDK | `10.0.108` |
| Rust compiler | `rustc 1.96.0` |
| Bash | `5.2.21` |

The runner image includes:

- Java 8 JDK/runtime for the runner, testers, and Java submissions
- `g++` backed by GCC 14 for C++23 submissions
- `python3` backed by Python 3.12 for Python submissions
- `mono-devel`, `mcs`, and `mono` for Mono C# submissions
- .NET 10 SDK for `.cs_net10` submissions and backward-compatible `.cs_net7` submissions
- `rustc` from the Rust stable channel for `.rs` submissions
- `zip` and `unzip` for artifact handling
- a native isolation helper that runs untrusted tester/submission execution as a restricted user

## Setup Local Environment Similar to the Runner

The most accurate local environment is the `ecs-runner` image from `marathon-match-api-v6`. Operators can build it with:

```bash
docker build -f ecs-runner/Dockerfile -t mm-ecs-runner:local ecs-runner
```

The ECS runner itself expects Topcoder service environment variables and normally exits quickly when those variables are not present. For local member testing, it is usually more practical to run the problem tester directly in a compatible Docker image.

The following Dockerfile approximates the current runner toolchain:

```dockerfile
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
    && wget -qO- https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path \
    && chmod -R a+rX "${RUSTUP_HOME}" "${CARGO_HOME}" \
    && rustc --version >/dev/null

ENV DOTNET_ROOT=/usr/lib/dotnet
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
ENV DOTNET_NOLOGO=1
ENV JAVA_TOOL_OPTIONS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0 -Djava.awt.headless=true -Dfile.encoding=UTF-8"
WORKDIR /workdir
```

Build and enter the image:

```bash
docker build -t marathon-local-runner .
docker run --rm -it -v "$PWD:/workdir" marathon-local-runner /bin/bash
```

Inside the container, compile the submission using the command for its language, then run the provided tester JAR with an execution command and seed. For example:

```bash
java -jar Tester.jar -exec "./Solution" -seed 1
```

For Java submissions, the execution command usually looks like:

```bash
java -cp /workdir Solution
```

For interpreted submissions, pass the interpreter command:

```bash
java -jar Tester.jar -exec "python3 /workdir/Solution.py" -seed 1
```

For Rust submissions, compile first and pass the compiled binary:

```bash
rustc --edition=2024 -O Solution.rs -o Solution
java -jar Tester.jar -exec "./Solution" -seed 1
```

Members may print debug information to standard error. The tester captures solution output and error text and the processor includes relevant output in the scoring artifacts.

## Download and Access Submissions

Submission access depends on your role and the stage of the match.

During an active match, members can access their own submissions and scoring artifacts from the Topcoder submission/review experience. Copilots and operators can monitor submissions from the Work app Submissions tab, including:

- scoring status
- score links
- generated artifacts
- runner log links, when available

After the match is complete and submissions are allowed to be public, other competitors' submissions may be available through the review/submission interface according to the match rules and Topcoder access controls.

## Example, Provisional, and System Scores

Marathon Match scoring is split into phase-specific scorer configurations.

| Phase type | Typical trigger | Purpose |
| --- | --- | --- |
| `EXAMPLE` | Submission phase | Fast feedback on example seeds |
| `PROVISIONAL` | Submission phase | Live provisional scoring during the match |
| `SYSTEM` | Review phase | Final system scoring after the match |

Each phase has:

- `phaseId`: the challenge phase that triggers this scorer config
- `startSeed`: first seed in the test range
- `numberOfTests`: number of seeds to execute

Example and Provisional scoring can both be mapped to the same open Submission phase. When both configs match the currently open phase, the system launches one ECS scorer task for each config.

System scoring is dispatched during Review for the pending review and uses the configured System seed range.

For each executed test, the generic runner records member-visible results with
1-based testcase ordinals rather than configured seed values:

- testcase ordinal
- raw tester score
- run time in milliseconds
- tester or solution error text

The runner writes public artifacts such as:

- `compile_log.txt`
- `output.txt`
- execution logs
- error logs, when failures occur

The old behavior where a leaderboard score of `1.0` represented "queued after example tests" should no longer be used as the public explanation. Current scoring status is represented through review summations, metadata, artifacts, and runner logs.

## Submission Queue and Progress

The current processor does not expose queue position by assigning a magic temporary score.

For Provisional and System scoring, the runner posts progress updates while tests are running. These updates are stored in review summation metadata:

| Metadata field | Meaning |
| --- | --- |
| `testProcess` | `provisional` or `system` |
| `testProgress` | progress from `0` to `1` |
| `testStatus` | `IN PROGRESS`, `SUCCESS`, or `FAILED` |
| `testProgressDetails.completedTests` | completed testcase count |
| `testProgressDetails.totalTests` | configured testcase count |
| `testProgressDetails.failedTests` | testcase count with errors |
| `testProgressDetails.message` | latest runner progress or failure message |

Operators can also inspect ECS runner logs. Runner log mappings are stored for each launched scoring task and can be exposed through:

```text
GET /v6/marathon-match/submissions/:submissionId/runner-logs
```

## Notification Emails

Notification behavior is driven by Topcoder review and notification services. The exact email template can vary by environment and challenge configuration.

Do not rely on the old three-email interpretation where:

- virus scan score `100` meant the submission was ready for examples
- example score `1.0` meant the submission entered the provisional queue
- provisional scoring later replaced the temporary score

In the current system, scoring state should be interpreted from the submission/review UI, review summation metadata, artifacts, and runner logs. If emails are sent, they should be treated as notifications of review/scoring events rather than the source of truth for queue state.

## Scoring Terminology

### Raw testcase score

The numeric score returned by the tester for one seed.

### Direct aggregate score

For the generic runner, the direct aggregate score is the average of the raw testcase scores for the configured seed range.

### Relative scoring

Relative scoring is controlled by the challenge setting `relativeScoringEnabled`. It applies when the runner callback includes per-seed `testScores` metadata.

When relative scoring is enabled, the system recalculates the latest submission from each member against the best current raw score for each testcase.

For each testcase:

- failed, missing, negative, or zero raw scores receive `0`
- the best raw score receives `100`
- all other valid scores receive `(lower score / higher score) * 100`

The final relative score is the average of those per-testcase relative scores. If every testcase fails, the aggregate score is `-1`.

### Score direction

Each Marathon Match config has a `scoreDirection`:

- `MAXIMIZE`: larger raw testcase scores are better
- `MINIMIZE`: smaller raw testcase scores are better

The configured direction determines which raw testcase score is considered best during relative scoring.

### Passing and failed scores

A review summation is passing when:

- the aggregate score is greater than or equal to `0`
- scoring is not still `IN PROGRESS`
- scoring did not finish with `FAILED` status

Negative scores and testcase errors are treated as failed scoring outcomes.

## Submission Network Isolation

The ECS task parent process has trusted network access so it can:

- fetch challenge configuration
- download the tester JAR
- download the member submission
- upload artifacts
- post scoring callbacks

The tester and submitted solution run in a separate isolated child process as an unprivileged `runner` user. The child process receives a scrubbed environment that does not include the runner access token. Socket creation is limited to `AF_UNIX`, which prevents live outbound network connections from the submitted solution.

## Multithreading and Resource Notes

CPU and memory limits are controlled by the ECS task definition revision configured for the challenge.

The generic runner executes the configured seeds sequentially. A submitted solution may create threads, but those threads share the CPU and memory allocated to the ECS task. Multithreading is therefore not guaranteed to improve scoring performance and can make local results less comparable to production if the local machine has different CPU allocation.

For best reproducibility, members should test with the same time limits, seed ranges, and a Docker image matching the active runner toolchain.
