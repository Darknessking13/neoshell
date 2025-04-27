// src/container_launcher.cpp
#define _GNU_SOURCE // Needed for clone, unshare
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/mount.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/resource.h> // For setrlimit
#include <unistd.h>
#include <vector>
#include <string>
#include <iostream>
#include <stdexcept> // For runtime_error
#include <fcntl.h>  // For O_RDONLY etc. Needed implicitly by sys/mount.h sometimes

#define STACK_SIZE (1024 * 1024) // 1MB stack for child

// Structure to pass arguments to the child function
struct child_args {
    char* rootfs_path;
    char** cmd_argv; // Null-terminated array for execv
    long long memory_limit_bytes; // Memory limit in bytes (0 for no limit)
};

// Function to be executed by the child process
static int child_function(void *arg) {
    struct child_args *args = (struct child_args *)arg;
    const char* container_hostname = "nsi-container";

    printf(" -> [Child PID: %d] Setting up container environment...\n", getpid());

    // 1. Set Hostname (UTS Namespace)
    if (sethostname(container_hostname, strlen(container_hostname)) == -1) {
        perror(" [Child] sethostname failed");
        return 1;
    }
    printf(" -> [Child] Hostname set to '%s'.\n", container_hostname);

    // Apply Memory Limit (using setrlimit - basic, not full cgroup control)
    if (args->memory_limit_bytes > 0) {
        struct rlimit mem_limit;
        mem_limit.rlim_cur = args->memory_limit_bytes;
        mem_limit.rlim_max = args->memory_limit_bytes;
        // RLIMIT_AS (address space) is often used, though RLIMIT_DATA might also be relevant
        if (setrlimit(RLIMIT_AS, &mem_limit) == -1) {
             perror(" [Child] setrlimit failed");
             // Non-fatal, proceed anyway
        } else {
             printf(" -> [Child] Memory limit set to %lld bytes (using setrlimit).\n", args->memory_limit_bytes);
        }
    }


    // 2. Chroot into the new root filesystem (Mount Namespace)
    if (chroot(args->rootfs_path) == -1) {
        perror(" [Child] chroot failed");
        fprintf(stderr, "       Rootfs path: %s\n", args->rootfs_path);
        return 1;
    }
    printf(" -> [Child] Changed root directory to %s.\n", args->rootfs_path);

    // Change working directory to the new root
    if (chdir("/") == -1) {
        perror(" [Child] chdir(\"/\") failed");
        return 1;
    }
    printf(" -> [Child] Changed working directory to '/'.\n");


    // 3. Mount /proc (Proc Namespace & Mount Namespace interaction)
    // Mount procfs *after* chroot, relative to the new root
    if (mount("proc", "/proc", "proc", 0, NULL) == -1) {
        perror(" [Child] mount proc failed");
        // This might be non-fatal depending on the application
        fprintf(stderr, "       Warning: Failed to mount /proc filesystem in container.\n");
    } else {
        printf(" -> [Child] Mounted proc filesystem at /proc.\n");
    }

    printf(" -> [Child] Ready to execute: %s\n", args->cmd_argv[0]);
    // Print args for debugging:
    // for(int i = 0; args->cmd_argv[i] != NULL; ++i) {
    //     printf("      Arg %d: %s\n", i, args->cmd_argv[i]);
    // }


    // 4. Execute the command (replaces the current process)
    if (execv(args->cmd_argv[0], args->cmd_argv) == -1) {
        perror(" [Child] execv failed");
        fprintf(stderr, "       Command: %s\n", args->cmd_argv[0]);
        // If execv fails, the child process should exit.
        exit(EXIT_FAILURE); // Use exit() here, not return, as execv replaces the process
    }

    // This point should never be reached if execv is successful
    fprintf(stderr, " [Child] Error: execv returned, which should not happen!\n");
    return 1; // Should not happen
}

int main(int argc, char *argv[]) {
    if (argc < 4) {
        fprintf(stderr, "Usage: %s <rootfs_path> <memory_limit_MB> <command> [args...]\n", argv[0]);
        fprintf(stderr, "  Example: %s /tmp/my-rootfs 0 /usr/bin/node /app/app.js\n", argv[0]);
        return EXIT_FAILURE;
    }

    // --- Arguments passed from Node.js orchestrator ---
    char* rootfs_path = argv[1];
    long long memory_limit_mb = atoll(argv[2]); // Use atoll for long long
    long long memory_limit_bytes = (memory_limit_mb > 0) ? (memory_limit_mb * 1024 * 1024) : 0;
    char **cmd_argv = &argv[3]; // command is argv[3], args are argv[4]...

    printf("[Parent PID: %d] Starting container setup...\n", getpid());
    printf("  Rootfs: %s\n", rootfs_path);
    printf("  Memory Limit: %lld MB (%lld Bytes)\n", memory_limit_mb, memory_limit_bytes);
    printf("  Command: %s\n", cmd_argv[0]);


    // --- Allocate stack for the child process ---
    // Using malloc for the stack is common for clone
    char *stack = (char*)malloc(STACK_SIZE);
    if (stack == NULL) {
        perror("malloc failed");
        return EXIT_FAILURE;
    }
    // Point stack_top to the *end* of the allocated memory, as stacks grow downwards
    char *stack_top = stack + STACK_SIZE;


    // --- Prepare arguments for the child ---
    struct child_args args;
    args.rootfs_path = rootfs_path;
    args.cmd_argv = cmd_argv;
    args.memory_limit_bytes = memory_limit_bytes;

    // --- Flags for clone ---
    // CLONE_NEWPID: New PID namespace. Child is PID 1 inside.
    // CLONE_NEWNS: New Mount namespace. Mounts don't propagate outside.
    // CLONE_NEWUTS: New UTS namespace. Allows setting hostname independently.
    // SIGCHLD: Send SIGCHLD to parent when child terminates. Needed for waitpid.
    int clone_flags = CLONE_NEWPID | CLONE_NEWNS | CLONE_NEWUTS | SIGCHLD;


    // --- Create the child process with new namespaces ---
    printf("[Parent] Calling clone()...\n");
    pid_t child_pid = clone(child_function, stack_top, clone_flags, &args);

    if (child_pid == -1) {
        perror("clone failed");
        free(stack);
        return EXIT_FAILURE;
    }

    printf("[Parent] Cloned child process with PID: %d\n", child_pid);


    // --- Optional: Cgroup setup would happen here (More Complex) ---
    // 1. Find/Create Cgroup path (e.g., /sys/fs/cgroup/memory/nsi/<container_id>)
    // 2. Write child_pid to cgroup.procs or tasks file
    // 3. Write memory limit to memory.limit_in_bytes or memory.max
    // ...Requires cgroup filesystem interaction...


    // --- Wait for the child process to terminate ---
    int status;
    printf("[Parent] Waiting for child PID %d to exit...\n", child_pid);
    if (waitpid(child_pid, &status, 0) == -1) {
        perror("waitpid failed");
        free(stack);
        return EXIT_FAILURE;
    }

    // --- Clean up stack ---
    free(stack);

    int exit_status = 0;
    if (WIFEXITED(status)) {
        exit_status = WEXITSTATUS(status);
        printf("[Parent] Child PID %d exited with status: %d\n", child_pid, exit_status);
    } else if (WIFSIGNALED(status)) {
        int signal_num = WTERMSIG(status);
        printf("[Parent] Child PID %d terminated by signal: %d (%s)\n", child_pid, signal_num, strsignal(signal_num));
        // Return a non-zero status to indicate abnormal termination
        exit_status = 128 + signal_num; // Common convention
    } else {
         printf("[Parent] Child PID %d terminated abnormally.\n", child_pid);
         exit_status = 1; // Generic error
    }

    return exit_status; // Return the child's exit status
}