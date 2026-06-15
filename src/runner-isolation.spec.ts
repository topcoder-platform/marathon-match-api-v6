import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REQUIRED_TOOLS = ['gcc', 'python3'];

/**
 * Checks whether a command is available for native isolation regression tests.
 *
 * @param command Executable name expected on PATH.
 * @returns True when the executable can be launched successfully.
 */
function isCommandAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

const describeIfToolsAvailable = REQUIRED_TOOLS.every(isCommandAvailable)
  ? describe
  : describe.skip;

describeIfToolsAvailable('mm-net-isolate seccomp socket filter', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'mm-net-isolate-'));
  });

  afterEach(() => {
    rmSync(workspace, { force: true, recursive: true });
  });

  it('keeps IPv4 sockets blocked in a child process after LD_PRELOAD is stripped', () => {
    const helperPath = compileIsolationHelper(workspace);
    const probePath = writeChildProcessProbe(workspace);

    const result = spawnSync(helperPath, ['python3', probePath], {
      encoding: 'utf8',
      env: process.env,
    });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.error).toBeUndefined();
    expect(output).toContain('AF_UNIX_ALLOWED');
    expect(output).toContain('IPV4_BLOCKED_EPERM');
    expect(result.status).toBe(0);
  });

  it('allows glibc thread stack introspection without exposing proc infrastructure', () => {
    const helperPath = compileIsolationHelper(workspace, [
      '-DMM_ENABLE_FS_SANDBOX=1',
    ]);
    const probePath = compileThreadAttributeProbe(workspace);

    const result = spawnSync(helperPath, [probePath], {
      encoding: 'utf8',
      env: process.env,
    });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (output.includes('Landlock filesystem sandbox is unavailable')) {
      expect(result.status).toBe(1);
      return;
    }

    expect(result.error).toBeUndefined();
    expect(output).toContain('PTHREAD_GETATTR_OK');
    expect(output).toContain('CGROUP_BLOCKED_EACCES');
    expect(result.status).toBe(0);
  });
});

/**
 * Builds the native isolation helper in runner-child mode for local tests.
 *
 * @param workspace Temporary directory that receives the compiled helper.
 * @param extraDefines Additional compiler defines used to enable optional
 * helper features in focused regression tests.
 * @returns Absolute path to the compiled helper executable.
 * @throws Error when gcc cannot compile the helper.
 */
function compileIsolationHelper(
  workspace: string,
  extraDefines: string[] = [],
): string {
  const helperPath = join(workspace, 'mm-net-isolate');
  const sourcePath = resolve(
    __dirname,
    '..',
    'ecs-runner',
    'scripts',
    'mm-net-isolate.c',
  );
  const result = spawnSync(
    'gcc',
    [
      '-O2',
      '-Wall',
      '-Wextra',
      '-DMM_SKIP_USER_DROP=1',
      '-DMM_ISOLATED_HOME="/tmp"',
      '-DMM_ISOLATED_NAME="jest-runner"',
      ...extraDefines,
      '-o',
      helperPath,
      sourcePath,
    ],
    { encoding: 'utf8' },
  );

  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      [
        'Failed to compile mm-net-isolate test helper.',
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return helperPath;
}

/**
 * Builds a native probe that exercises pthread_getattr_np under Landlock.
 *
 * @param workspace Temporary directory that receives the probe source and binary.
 * @returns Absolute path to the compiled probe executable.
 * @throws Error when gcc cannot compile the probe.
 */
function compileThreadAttributeProbe(workspace: string): string {
  const sourcePath = join(workspace, 'pthread-getattr-probe.c');
  const probePath = join(workspace, 'pthread-getattr-probe');

  writeFileSync(
    sourcePath,
    String.raw`
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    pthread_attr_t attr;
    int err = pthread_getattr_np(pthread_self(), &attr);
    if (err != 0) {
        printf("PTHREAD_GETATTR_ERR_%d\n", err);
        return 2;
    }

    pthread_attr_destroy(&attr);
    puts("PTHREAD_GETATTR_OK");

    int fd = open("/proc/self/cgroup", O_RDONLY | O_CLOEXEC);
    if (fd >= 0) {
        close(fd);
        puts("CGROUP_READABLE");
        return 3;
    }

    if (errno == EACCES) {
        puts("CGROUP_BLOCKED_EACCES");
        return 0;
    }

    printf("CGROUP_BLOCKED_ERRNO_%d\n", errno);
    return 4;
}
`,
    'utf8',
  );

  const result = spawnSync(
    'gcc',
    ['-O2', '-Wall', '-Wextra', '-pthread', '-o', probePath, sourcePath],
    { encoding: 'utf8' },
  );

  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      [
        'Failed to compile pthread_getattr_np probe.',
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return probePath;
}

/**
 * Writes a Python probe that forks a child process, strips LD_PRELOAD, and
 * verifies the inherited seccomp filter still denies IPv4 socket creation.
 *
 * @param workspace Temporary directory that receives the probe script.
 * @returns Absolute path to the probe script.
 */
function writeChildProcessProbe(workspace: string): string {
  const probePath = join(workspace, 'probe.py');
  writeFileSync(
    probePath,
    String.raw`
import errno
import os
import socket
import subprocess
import sys

unix_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
unix_socket.close()
print("AF_UNIX_ALLOWED")

child_code = r"""
import errno
import os
import socket
import sys

if "LD_PRELOAD" in os.environ:
    print("LD_PRELOAD_PRESENT")
    sys.exit(4)

try:
    ipv4_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
except PermissionError as error:
    if error.errno == errno.EPERM:
        print("IPV4_BLOCKED_EPERM")
        sys.exit(0)
    print("IPV4_BLOCKED_PERMISSION_" + str(error.errno))
    sys.exit(2)
except OSError as error:
    print("IPV4_BLOCKED_OSERROR_" + str(error.errno))
    sys.exit(3)
else:
    ipv4_socket.close()
    print("IPV4_SOCKET_ALLOWED")
    sys.exit(1)
"""

child_env = os.environ.copy()
child_env["LD_PRELOAD"] = "/tmp/libnosocket-placeholder.so"
child_env.pop("LD_PRELOAD", None)

result = subprocess.run(
    [sys.executable, "-c", child_code],
    env=child_env,
    stderr=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
)

sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
`,
    'utf8',
  );

  return probePath;
}
