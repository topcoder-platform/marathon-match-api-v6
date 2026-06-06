#define _GNU_SOURCE

#include <errno.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS SECCOMP_RET_KILL
#endif

#ifndef MM_ISOLATED_UID
#define MM_ISOLATED_UID 10001
#endif

#ifndef MM_ISOLATED_GID
#define MM_ISOLATED_GID 10001
#endif

#ifndef MM_ISOLATED_HOME
#define MM_ISOLATED_HOME "/home/runner"
#endif

#ifndef MM_ISOLATED_NAME
#define MM_ISOLATED_NAME "runner"
#endif

#ifndef MM_SUPERVISE_CHILD
#define MM_SUPERVISE_CHILD 0
#endif

#ifndef MM_SKIP_USER_DROP
#define MM_SKIP_USER_DROP 0
#endif

#if defined(__x86_64__)
#define MM_AUDIT_ARCH AUDIT_ARCH_X86_64
#define MM_BLOCK_X32_SYSCALLS 1
#define MM_X32_SYSCALL_BIT 0x40000000U
#elif defined(__aarch64__)
#define MM_AUDIT_ARCH AUDIT_ARCH_AARCH64
#define MM_BLOCK_X32_SYSCALLS 0
#else
#error "Unsupported architecture for mm-net-isolate"
#endif

#define MM_SOCKET_DENY (SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

#if MM_SUPERVISE_CHILD
static volatile sig_atomic_t supervised_child_pid = -1;
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
#if MM_BLOCK_X32_SYSCALLS
        BPF_STMT(BPF_ALU + BPF_AND + BPF_K, MM_X32_SYSCALL_BIT),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET + BPF_K, MM_SOCKET_DENY),
        BPF_STMT(BPF_LD + BPF_W + BPF_ABS, offsetof(struct seccomp_data, nr)),
#endif
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, __NR_socket, 0, 4),
        BPF_STMT(BPF_LD + BPF_W + BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET + BPF_K, MM_SOCKET_DENY),
        BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, __NR_socketpair, 0, 4),
        BPF_STMT(BPF_LD + BPF_W + BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET + BPF_K, MM_SOCKET_DENY),
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
    const char *resolved_tmpdir = tmpdir != NULL && tmpdir[0] != '\0' ? tmpdir : "/tmp";
    const char *dotnet_root = getenv("DOTNET_ROOT");
    const char *java_tool_options = getenv("JAVA_TOOL_OPTIONS");
    const char *rustup_home = getenv("RUSTUP_HOME");
    const char *cargo_home = getenv("CARGO_HOME");
    const char *rustup_toolchain = getenv("RUSTUP_TOOLCHAIN");
    char dotnet_cli_home[256];

    clearenv();

    setenv(
        "PATH",
        path != NULL && path[0] != '\0'
            ? path
            : "/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        1
    );
    setenv("HOME", MM_ISOLATED_HOME, 1);
    setenv("TMPDIR", resolved_tmpdir, 1);
    snprintf(
        dotnet_cli_home,
        sizeof(dotnet_cli_home),
        "%s/dotnet-cli-home-%s",
        resolved_tmpdir,
        MM_ISOLATED_NAME
    );
    setenv("DOTNET_CLI_HOME", dotnet_cli_home, 1);
    setenv("DOTNET_CLI_TELEMETRY_OPTOUT", "1", 1);
    setenv("DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "1", 1);
    setenv("DOTNET_NOLOGO", "1", 1);
    setenv("RUNNER_ISOLATED_EXECUTION", "1", 1);
    setenv("MM_ISOLATED_USER", MM_ISOLATED_NAME, 1);

    copy_env_if_present("LANG", lang);
    copy_env_if_present("LC_ALL", lc_all);
    copy_env_if_present("TZ", tz);
    copy_env_if_present("DOTNET_ROOT", dotnet_root);
    copy_env_if_present("JAVA_TOOL_OPTIONS", java_tool_options);
    copy_env_if_present("RUSTUP_HOME", rustup_home);
    copy_env_if_present("CARGO_HOME", cargo_home);
    copy_env_if_present("RUSTUP_TOOLCHAIN", rustup_toolchain);
}

/**
 * Drops all supplementary groups and switches to the compile-time isolated UID/GID.
 * The helper is invoked by the trusted root runner before the submitted command starts.
 *
 * Returns 0 on success and 1 when any privilege drop call fails.
 */
static int drop_to_isolated_user(void) {
#if MM_SKIP_USER_DROP
    return 0;
#else
    if (setgroups(0, NULL) != 0) {
        perror("setgroups");
        return 1;
    }

    if (setgid(MM_ISOLATED_GID) != 0) {
        perror("setgid");
        return 1;
    }

    if (setuid(MM_ISOLATED_UID) != 0) {
        perror("setuid");
        return 1;
    }

    return 0;
#endif
}

/**
 * Enters the low-privilege socket-restricted execution context.
 *
 * Returns 0 on success and 1 when the user drop or seccomp setup fails.
 */
static int enter_isolated_execution(void) {
    if (drop_to_isolated_user() != 0) {
        return 1;
    }

    if (install_socket_filter() != 0) {
        return 1;
    }

    return 0;
}

/**
 * Forwards termination signals from the supervised wrapper to the isolated
 * solution process group. The wrapper remains signalable by the Java runner
 * because its real UID is still the runner UID.
 */
#if MM_SUPERVISE_CHILD
static void forward_signal_to_child(int signo) {
    pid_t child_pid = (pid_t) supervised_child_pid;
    if (child_pid > 0) {
        if (kill(-child_pid, signo) != 0) {
            kill(child_pid, signo);
        }
    }
}

/**
 * Installs signal forwarding for the supervised solution wrapper.
 */
static void install_supervisor_signal_handlers(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = forward_signal_to_child;
    sigemptyset(&action.sa_mask);

    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGHUP, &action, NULL);
}

/**
 * Converts a waitpid status into the conventional process exit code returned
 * to the Java runner.
 */
static int wait_status_to_exit_code(int status) {
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }

    if (WIFSIGNALED(status)) {
        return 128 + WTERMSIG(status);
    }

    return 1;
}

/**
 * Runs the target command as an isolated child while this wrapper waits
 * as a small supervisor. This lets the Java runner terminate the wrapper on
 * timeouts and have the wrapper relay the signal to the lower-privilege scorer
 * process group.
 *
 * argc/argv are the original command-line arguments where argv[1] is the target
 * executable. The return value is the target command's exit code.
 */
static int run_supervised(int argc, char **argv) {
    int status;
    pid_t child_pid = fork();
    (void) argc;

    if (child_pid < 0) {
        perror("fork");
        return 1;
    }

    if (child_pid == 0) {
        if (setpgid(0, 0) != 0) {
            perror("setpgid");
            _exit(1);
        }

        if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) {
            perror("prctl(PR_SET_PDEATHSIG)");
            _exit(1);
        }

        if (getppid() == 1) {
            _exit(137);
        }

        if (enter_isolated_execution() != 0) {
            _exit(1);
        }

        execvp(argv[1], &argv[1]);
        perror("execvp");
        _exit(127);
    }

    supervised_child_pid = child_pid;
    setpgid(child_pid, child_pid);
    install_supervisor_signal_handlers();

    while (waitpid(child_pid, &status, 0) < 0) {
        if (errno != EINTR) {
            perror("waitpid");
            kill(-child_pid, SIGKILL);
            return 1;
        }
    }

    kill(-child_pid, SIGKILL);
    return wait_status_to_exit_code(status);
}
#endif

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <command> [args...]\n", argv[0]);
        return 64;
    }

    close_extra_fds();
    sanitize_environment();

#if MM_SUPERVISE_CHILD
    return run_supervised(argc, argv);
#else
    if (enter_isolated_execution() != 0) {
        return 1;
    }

    execvp(argv[1], &argv[1]);
    perror("execvp");
    return 127;
#endif
}
