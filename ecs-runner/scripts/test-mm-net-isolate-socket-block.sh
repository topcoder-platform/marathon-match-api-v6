#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

HELPER="${WORK_DIR}/mm-net-isolate-test"

gcc -O2 -Wall -Wextra \
  -DMM_SKIP_USER_DROP=1 \
  -DMM_ISOLATED_HOME=\"/tmp\" \
  -DMM_ISOLATED_NAME=\"test-runner\" \
  -o "${HELPER}" \
  "${ROOT_DIR}/ecs-runner/scripts/mm-net-isolate.c"

"${HELPER}" python3 <<'PY'
import ctypes
import errno
import os
import platform
import socket
import sys


def socket_syscall_number():
    machine = platform.machine()
    if machine == "x86_64":
        return 41
    if machine == "aarch64":
        return 198
    raise RuntimeError(f"unsupported machine for test: {machine}")


libc = ctypes.CDLL("libc.so.6", use_errno=True)
libc.syscall.restype = ctypes.c_long

ctypes.set_errno(0)
fd = libc.syscall(
    ctypes.c_long(socket_syscall_number()),
    socket.AF_INET,
    socket.SOCK_STREAM,
    0,
)
if fd >= 0:
    os.close(fd)
    print("raw AF_INET socket syscall succeeded", file=sys.stderr)
    sys.exit(2)

if ctypes.get_errno() != errno.EPERM:
    print(
        f"raw AF_INET socket syscall returned errno {ctypes.get_errno()}, expected {errno.EPERM}",
        file=sys.stderr,
    )
    sys.exit(3)

if platform.machine() == "x86_64":
    ctypes.set_errno(0)
    fd = libc.syscall(
        ctypes.c_long(0x40000000 | socket_syscall_number()),
        socket.AF_INET,
        socket.SOCK_STREAM,
        0,
    )
    if fd >= 0:
        os.close(fd)
        print("x32-numbered socket syscall succeeded", file=sys.stderr)
        sys.exit(4)
    if ctypes.get_errno() != errno.EPERM:
        print(
            f"x32-numbered socket syscall returned errno {ctypes.get_errno()}, expected {errno.EPERM}",
            file=sys.stderr,
        )
        sys.exit(5)

left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
left.close()
right.close()
print("raw AF_INET socket syscalls blocked; AF_UNIX socketpair still allowed")
PY
