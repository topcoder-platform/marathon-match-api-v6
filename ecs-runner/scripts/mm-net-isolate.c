#define _GNU_SOURCE

#include <errno.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS SECCOMP_RET_KILL
#endif

#define ISOLATED_UID 10001
#define ISOLATED_GID 10001

#if defined(__x86_64__)
#define MM_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define MM_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "Unsupported architecture for mm-net-isolate"
#endif

static void copy_env_if_present(const char *name, const char *value) {
    if (value != NULL && value[0] != '\0') {
        setenv(name, value, 1);
    }
}

static void close_extra_fds(void) {
    struct rlimit limit;
    int max_fd = 1024;

    if (getrlimit(RLIMIT_NOFILE, &limit) == 0 && limit.rlim_cur != RLIM_INFINITY) {
        max_fd = (int) limit.rlim_cur;
    }

    for (int fd = 3; fd < max_fd; fd++) {
        close(fd);
    }
}

static int install_socket_filter(void) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD + BPF_W + BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, MM_AUDIT_ARCH, 1, 0),
        BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD + BPF_W + BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, __NR_socket, 0, 4),
        BPF_STMT(BPF_LD + BPF_W + BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
        BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, __NR_socketpair, 0, 4),
        BPF_STMT(BPF_LD + BPF_W + BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
        BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ALLOW),
    };

    struct sock_fprog program = {
        .len = (unsigned short) (sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        perror("prctl(PR_SET_NO_NEW_PRIVS)");
        return 1;
    }

    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) {
        perror("prctl(PR_SET_SECCOMP)");
        return 1;
    }

    return 0;
}

static void sanitize_environment(void) {
    const char *path = getenv("PATH");
    const char *lang = getenv("LANG");
    const char *lc_all = getenv("LC_ALL");
    const char *tz = getenv("TZ");
    const char *tmpdir = getenv("TMPDIR");
    const char *dotnet_root = getenv("DOTNET_ROOT");
    const char *java_tool_options = getenv("JAVA_TOOL_OPTIONS");

    clearenv();

    setenv(
        "PATH",
        path != NULL && path[0] != '\0'
            ? path
            : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        1
    );
    setenv("HOME", "/home/runner", 1);
    setenv("TMPDIR", tmpdir != NULL && tmpdir[0] != '\0' ? tmpdir : "/tmp", 1);
    setenv("DOTNET_CLI_HOME", "/tmp/dotnet-cli-home", 1);
    setenv("DOTNET_CLI_TELEMETRY_OPTOUT", "1", 1);
    setenv("DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "1", 1);
    setenv("DOTNET_NOLOGO", "1", 1);
    setenv("RUNNER_ISOLATED_EXECUTION", "1", 1);

    copy_env_if_present("LANG", lang);
    copy_env_if_present("LC_ALL", lc_all);
    copy_env_if_present("TZ", tz);
    copy_env_if_present("DOTNET_ROOT", dotnet_root);
    copy_env_if_present("JAVA_TOOL_OPTIONS", java_tool_options);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <command> [args...]\n", argv[0]);
        return 64;
    }

    close_extra_fds();
    sanitize_environment();

    if (setgroups(0, NULL) != 0) {
        perror("setgroups");
        return 1;
    }

    if (setgid(ISOLATED_GID) != 0) {
        perror("setgid");
        return 1;
    }

    if (setuid(ISOLATED_UID) != 0) {
        perror("setuid");
        return 1;
    }

    if (install_socket_filter() != 0) {
        return 1;
    }

    execvp(argv[1], &argv[1]);
    perror("execvp");
    return 127;
}
