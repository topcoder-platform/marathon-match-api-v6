#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
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

#ifndef MM_CLOSE_FD_FALLBACK_MAX
#define MM_CLOSE_FD_FALLBACK_MAX ((rlim_t) 1048576)
#endif

#ifndef MM_INSTALL_SOCKET_FILTER
#define MM_INSTALL_SOCKET_FILTER 1
#endif

#ifndef MM_DROP_SUPERVISOR_PRIVS
#define MM_DROP_SUPERVISOR_PRIVS 0
#endif

#ifndef MM_ENABLE_FS_SANDBOX
#define MM_ENABLE_FS_SANDBOX 0
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

#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup 425
#endif

#ifndef __NR_io_uring_enter
#define __NR_io_uring_enter 426
#endif

#ifndef __NR_io_uring_register
#define __NR_io_uring_register 427
#endif

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif

#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif

#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#ifndef CAP_KILL
#define CAP_KILL 5
#endif

#if MM_SUPERVISE_CHILD
static volatile sig_atomic_t supervised_child_pid = -1;
#endif

static void copy_env_if_present(const char *name, const char *value) {
    if (value != NULL && value[0] != '\0') {
        setenv(name, value, 1);
    }
}

/**
 * Closes inherited descriptors before the sandboxed command starts.
 *
 * The network sandbox only blocks creating new sockets, so inherited parent
 * descriptors must be removed independently of RLIMIT_NOFILE.
 */
static void close_extra_fds(void) {
#ifdef __NR_close_range
    if (syscall(__NR_close_range, 3U, ~0U, 0U) == 0) {
        return;
    }
#endif

    DIR *fd_dir = opendir("/proc/self/fd");
    if (fd_dir != NULL) {
        int fd_dir_fd = dirfd(fd_dir);
        struct dirent *entry;

        while ((entry = readdir(fd_dir)) != NULL) {
            char *end = NULL;
            unsigned long fd;

            errno = 0;
            fd = strtoul(entry->d_name, &end, 10);
            if (
                errno != 0
                || end == entry->d_name
                || *end != '\0'
                || fd < 3
                || fd > (unsigned long) INT_MAX
                || (int) fd == fd_dir_fd
            ) {
                continue;
            }

            close((int) fd);
        }

        closedir(fd_dir);
        return;
    }

    struct rlimit limit;
    rlim_t max_fd = MM_CLOSE_FD_FALLBACK_MAX;

    if (
        getrlimit(RLIMIT_NOFILE, &limit) == 0
        && limit.rlim_cur != RLIM_INFINITY
        && limit.rlim_cur < max_fd
    ) {
        max_fd = limit.rlim_cur;
    }

    for (rlim_t fd = 3; fd < max_fd; fd++) {
        close((int) fd);
    }
}

#if MM_INSTALL_SOCKET_FILTER
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
        /* io_uring can create sockets in-kernel through IORING_OP_SOCKET. */
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, __NR_io_uring_setup, 0, 1),
        BPF_STMT(BPF_RET + BPF_K, MM_SOCKET_DENY),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, __NR_io_uring_enter, 0, 1),
        BPF_STMT(BPF_RET + BPF_K, MM_SOCKET_DENY),
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, __NR_io_uring_register, 0, 1),
        BPF_STMT(BPF_RET + BPF_K, MM_SOCKET_DENY),
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
#endif

#if MM_ENABLE_FS_SANDBOX
static int landlock_create_ruleset_wrapper(
    const struct landlock_ruleset_attr *attr,
    size_t size,
    __u32 flags
) {
    return (int) syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int landlock_add_rule_wrapper(
    int ruleset_fd,
    enum landlock_rule_type rule_type,
    const void *rule_attr,
    __u32 flags
) {
    return (int) syscall(
        __NR_landlock_add_rule,
        ruleset_fd,
        rule_type,
        rule_attr,
        flags
    );
}

static int landlock_restrict_self_wrapper(int ruleset_fd, __u32 flags) {
    return (int) syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

/**
 * Returns the Landlock filesystem access rights supported by the running
 * kernel and the headers used to build this helper.
 */
static __u64 supported_landlock_fs_access(int abi_version) {
    __u64 access =
        LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_CHAR |
        LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_MAKE_SOCK |
        LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK |
        LANDLOCK_ACCESS_FS_MAKE_SYM;

    if (abi_version >= 2) {
        access |= LANDLOCK_ACCESS_FS_REFER;
    }

    if (abi_version >= 3) {
        access |= LANDLOCK_ACCESS_FS_TRUNCATE;
    }

    return access;
}

static __u64 landlock_read_execute_dir_access(__u64 handled_access) {
    return handled_access & (
        LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR
    );
}

static __u64 landlock_read_only_access(__u64 handled_access) {
    return handled_access & (
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR
    );
}

static __u64 landlock_read_write_file_access(__u64 handled_access) {
    __u64 access =
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_WRITE_FILE;

    if (handled_access & LANDLOCK_ACCESS_FS_TRUNCATE) {
        access |= LANDLOCK_ACCESS_FS_TRUNCATE;
    }

    return handled_access & access;
}

static __u64 landlock_writable_dir_access(__u64 handled_access) {
    __u64 access =
        LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_MAKE_SOCK |
        LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_SYM;

    if (handled_access & LANDLOCK_ACCESS_FS_REFER) {
        access |= LANDLOCK_ACCESS_FS_REFER;
    }

    if (handled_access & LANDLOCK_ACCESS_FS_TRUNCATE) {
        access |= LANDLOCK_ACCESS_FS_TRUNCATE;
    }

    return handled_access & access;
}

/**
 * Adds one filesystem allow rule. Missing optional paths are ignored so the
 * same helper can run across the supported language-runtime image variants.
 */
static int add_landlock_path_rule(
    int ruleset_fd,
    const char *path,
    __u64 allowed_access,
    __u64 handled_access,
    int required
) {
    int fd;
    int result;
    struct stat stat_buffer;
    struct landlock_path_beneath_attr path_beneath;
    __u64 path_access = allowed_access & handled_access;

    if (path_access == 0) {
        return 0;
    }

    fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
        if (!required && (errno == ENOENT || errno == ENOTDIR)) {
            return 0;
        }
        fprintf(stderr, "open(%s): %s\n", path, strerror(errno));
        return 1;
    }

    if (fstat(fd, &stat_buffer) != 0) {
        fprintf(stderr, "fstat(%s): %s\n", path, strerror(errno));
        close(fd);
        return 1;
    }

    if (!S_ISDIR(stat_buffer.st_mode)) {
        path_access &= (
            LANDLOCK_ACCESS_FS_EXECUTE |
            LANDLOCK_ACCESS_FS_WRITE_FILE |
            LANDLOCK_ACCESS_FS_READ_FILE |
            LANDLOCK_ACCESS_FS_TRUNCATE
        );
    }

    memset(&path_beneath, 0, sizeof(path_beneath));
    path_beneath.allowed_access = path_access;
    path_beneath.parent_fd = fd;

    result = landlock_add_rule_wrapper(
        ruleset_fd,
        LANDLOCK_RULE_PATH_BENEATH,
        &path_beneath,
        0
    );
    close(fd);

    if (result != 0) {
        fprintf(stderr, "landlock_add_rule(%s): %s\n", path, strerror(errno));
        return 1;
    }

    return 0;
}

static int add_landlock_paths(
    int ruleset_fd,
    const char *const *paths,
    size_t path_count,
    __u64 allowed_access,
    __u64 handled_access,
    int required
) {
    size_t index;
    for (index = 0; index < path_count; index++) {
        if (
            add_landlock_path_rule(
                ruleset_fd,
                paths[index],
                allowed_access,
                handled_access,
                required
            ) != 0
        ) {
            return 1;
        }
    }
    return 0;
}

/**
 * Restricts submitted solution filesystem access to runtime/toolchain files and
 * scorer-owned writable locations. Infrastructure-revealing files such as
 * /etc/hostname, /etc/resolv.conf, /proc/self/cgroup, /proc/self/mounts, and
 * proc network tables are intentionally omitted from the allowlist.
 */
static int install_filesystem_filter(void) {
    static const char *const read_execute_paths[] = {
        "/bin",
        "/sbin",
        "/usr",
        "/lib",
        "/lib64",
        "/opt"
    };
    static const char *const read_only_paths[] = {
        "/etc/dotnet",
        "/etc/group",
        "/etc/ld.so.cache",
        "/etc/localtime",
        "/etc/mono",
        "/etc/nsswitch.conf",
        "/etc/passwd",
        "/etc/protocols",
        "/etc/services",
        "/etc/ssl/certs"
    };
    static const char *const read_write_paths[] = {
        "/dev/null",
        "/dev/random",
        "/dev/urandom",
        "/dev/zero"
    };
    static const char *const writable_paths[] = {
        "/tmp",
        MM_ISOLATED_HOME
    };

    int abi_version = landlock_create_ruleset_wrapper(
        NULL,
        0,
        LANDLOCK_CREATE_RULESET_VERSION
    );
    int ruleset_fd;
    struct landlock_ruleset_attr ruleset_attr;
    __u64 handled_access;

    if (abi_version <= 0) {
        fprintf(
            stderr,
            "Landlock filesystem sandbox is unavailable; refusing to run submitted command: %s\n",
            strerror(errno)
        );
        return 1;
    }

    handled_access = supported_landlock_fs_access(abi_version);
    memset(&ruleset_attr, 0, sizeof(ruleset_attr));
    ruleset_attr.handled_access_fs = handled_access;

    ruleset_fd = landlock_create_ruleset_wrapper(
        &ruleset_attr,
        sizeof(ruleset_attr),
        0
    );
    if (ruleset_fd < 0) {
        perror("landlock_create_ruleset");
        return 1;
    }

    if (
        add_landlock_paths(
            ruleset_fd,
            read_execute_paths,
            sizeof(read_execute_paths) / sizeof(read_execute_paths[0]),
            landlock_read_execute_dir_access(handled_access),
            handled_access,
            0
        ) != 0
            || add_landlock_paths(
                ruleset_fd,
                read_only_paths,
                sizeof(read_only_paths) / sizeof(read_only_paths[0]),
                landlock_read_only_access(handled_access),
                handled_access,
                0
            ) != 0
            || add_landlock_paths(
                ruleset_fd,
                read_write_paths,
                sizeof(read_write_paths) / sizeof(read_write_paths[0]),
                landlock_read_write_file_access(handled_access),
                handled_access,
                0
            ) != 0
            || add_landlock_paths(
                ruleset_fd,
                writable_paths,
                sizeof(writable_paths) / sizeof(writable_paths[0]),
                landlock_writable_dir_access(handled_access),
                handled_access,
                1
            ) != 0
    ) {
        close(ruleset_fd);
        return 1;
    }

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        perror("prctl(PR_SET_NO_NEW_PRIVS)");
        close(ruleset_fd);
        return 1;
    }

    if (landlock_restrict_self_wrapper(ruleset_fd, 0) != 0) {
        perror("landlock_restrict_self");
        close(ruleset_fd);
        return 1;
    }

    close(ruleset_fd);
    return 0;
}
#endif

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
 * Enters the low-privilege execution context.
 *
 * Returns 0 on success and 1 when the user drop or seccomp setup fails.
 */
static int enter_isolated_execution(void) {
    if (drop_to_isolated_user() != 0) {
        return 1;
    }

#if MM_ENABLE_FS_SANDBOX
    if (install_filesystem_filter() != 0) {
        return 1;
    }
#endif

#if MM_INSTALL_SOCKET_FILTER
    if (install_socket_filter() != 0) {
        return 1;
    }
#endif

    return 0;
}

/**
 * Forwards termination signals from the supervised wrapper to the isolated
 * solution process group. The wrapper remains signalable by the Java runner
 * because its real UID is still the runner UID.
 */
#if MM_SUPERVISE_CHILD
static int signal_child_process_group(pid_t child_pid, int signo) {
    if (kill(-child_pid, signo) == 0 || errno == ESRCH) {
        return 0;
    }

    if (kill(child_pid, signo) == 0 || errno == ESRCH) {
        return 0;
    }

    return errno;
}

static void forward_signal_to_child(int signo) {
    pid_t child_pid = (pid_t) supervised_child_pid;
    if (child_pid > 0) {
        int signal_error = signal_child_process_group(child_pid, signo);
        if (signo == SIGTERM) {
            int kill_error = signal_child_process_group(child_pid, SIGKILL);
            if (signal_error == 0) {
                signal_error = kill_error;
            }
        }
        if (signal_error == EPERM) {
            _exit(128 + signo);
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
 * Drops the supervising wrapper back to the real user that invoked the setuid
 * scorer helper while retaining only CAP_KILL. The already-forked child keeps
 * the temporary root privilege it needs to switch to the configured isolated
 * UID before exec.
 */
static int drop_supervisor_to_invoker(void) {
#if MM_DROP_SUPERVISOR_PRIVS
    uid_t uid = getuid();
    gid_t gid = getgid();
    struct __user_cap_header_struct cap_header;
    struct __user_cap_data_struct cap_data[_LINUX_CAPABILITY_U32S_3];

    if (uid == 0 && gid == 0) {
        return 0;
    }

    if (prctl(PR_SET_KEEPCAPS, 1, 0, 0, 0) != 0) {
        perror("supervisor prctl(PR_SET_KEEPCAPS)");
        return 1;
    }

    if (setgroups(0, NULL) != 0) {
        perror("supervisor setgroups");
        return 1;
    }

    if (setgid(gid) != 0) {
        perror("supervisor setgid");
        return 1;
    }

    if (setuid(uid) != 0) {
        perror("supervisor setuid");
        return 1;
    }

    memset(&cap_header, 0, sizeof(cap_header));
    memset(&cap_data, 0, sizeof(cap_data));
    cap_header.version = _LINUX_CAPABILITY_VERSION_3;
    cap_header.pid = 0;
    cap_data[CAP_KILL / 32].effective = 1U << (CAP_KILL % 32);
    cap_data[CAP_KILL / 32].permitted = 1U << (CAP_KILL % 32);
    if (syscall(SYS_capset, &cap_header, &cap_data) != 0) {
        perror("supervisor capset(CAP_KILL)");
        return 1;
    }

    if (prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0) != 0) {
        perror("supervisor prctl(PR_SET_KEEPCAPS clear)");
        return 1;
    }
#endif
    return 0;
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
    if (drop_supervisor_to_invoker() != 0) {
        kill(-child_pid, SIGKILL);
        return 1;
    }
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
