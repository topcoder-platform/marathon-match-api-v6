# ECS Runner Tester Boilerplate

This folder contains the reusable Java boilerplate used to compile marathon tester source files.

## Included components
- `src/main/java/com/topcoder/scorer/*`: shared scorer models/services used by the ECS runner.
- `src/main/java/com/topcoder/marathon/*`: marathon tester framework ported from `tc-mm-164`.
- `checker/*`: language checker scripts ported from `tc-mm-164`.

## How it is used
- The API compilation worker copies this folder into a temp workspace.
- The configured tester source code (for example `BridgeRunnersTester.java`) is written into `src/main/java`.
- Maven packages all boilerplate + tester code into the tester JAR artifact.
