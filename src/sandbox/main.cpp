// neoshell/src/sandbox/main.cpp
#define _GNU_SOURCE // Needed for unshare, pivot_root, setns, etc.
#include <iostream>
#include <vector>
#include <string>
#include <cstring> // For strerror, strlen
#include <stdexcept>
#include <unistd.h> // For syscalls like unshare, execve, chdir, pivot_root, getuid, getgid, sethostname
#include <sched.h>  // For clone flags (CLONE_NEWUSER, etc.)
#include <sys/mount.h> // For mount, umount2
#include <sys/stat.h> // For mkdir
#include <sys/syscall.h> // For pivot_root syscall number if needed
#include <sys/wait.h> // For waitpid (might be needed for advanced uid_map setup)
#include <fcntl.h>  // For open
#include <cstdlib>  // For exit
#include <getopt.h> // For argument parsing
#include <map>      // For environment variables
#include <errno.h>  // Include errno for error checking

// Include the utils header (even if currently empty)
#include "utils.h"

// --- Basic Error Handling ---
void die(const char* msg) {
    int saved_errno = errno; // Save errno immediately
    fprintf(stderr, "[nsi-sandbox] FATAL ERROR: %s", msg);
    if (saved_errno != 0) { // Only print strerror if errno was set by a syscall
         fprintf(stderr, ": %s (errno %d)\n", strerror(saved_errno), saved_errno);
    } else {
         fprintf(stderr, "\n"); // Just print newline if no syscall error
    }
    exit(EXIT_FAILURE);
}

// Log messages to stderr to avoid interfering with container stdout
void log_msg(const char* msg) {
    fprintf(stderr, "[nsi-sandbox] %s\n", msg);
}

// --- Argument Parsing Structure ---
struct Args {
    std::string rootfs;
    std::string workdir;
    std::string cgroup_id;
    std::string mem_limit;
    // std::string cpu_limit; // TODO: Add later if needed
    std::vector<std::string> cmd;
    std::map<std::string, std::string> env_vars;
};

// --- Argument Parsing Function (Revised) ---
void parse_args(int argc, char* argv[], Args& args) {
    struct option long_options[] = {
        {"rootfs",    required_argument, 0, 'r'},
        {"workdir",   required_argument, 0, 'w'},
        {"env",       required_argument, 0, 'e'},
        {"mem",       required_argument, 0, 'm'},
        {"cgroup-id", required_argument, 0, 'g'},
        // {"cpu",     required_argument, 0, 'p'}, // Example for future cpu limit
        {0, 0, 0, 0}
    };

    int opt;
    // Options string matching short options in long_options
    const char *optstring = "r:w:e:m:g:";

    // Reset getopt's internal index
    optind = 1;

    // Parse all options first
    while ((opt = getopt_long(argc, argv, optstring, long_options, NULL)) != -1) {
        switch (opt) {
            case 'r': args.rootfs = optarg; break;
            case 'w': args.workdir = optarg; break;
            case 'm': args.mem_limit = optarg; break;
            case 'g': args.cgroup_id = optarg; break;
            // case 'p': args.cpu_limit = optarg; break; // Future cpu limit
            case 'e': {
                std::string env_pair = optarg;
                size_t eq_pos = env_pair.find('=');
                // Ensure there's an '=' and the key part isn't empty
                if (eq_pos != std::string::npos && eq_pos > 0) {
                    args.env_vars[env_pair.substr(0, eq_pos)] = env_pair.substr(eq_pos + 1);
                } else {
                    fprintf(stderr, "[nsi-sandbox] Warning: Ignoring invalid env var format: %s\n", optarg);
                }
                break;
            }
            case '?': // Unknown option or missing argument detected by getopt
                // getopt_long usually prints its own error message for '?'
                fprintf(stderr, "Usage: %s --rootfs <path> --cgroup-id <id> [--workdir <path>] [--mem <limit>] [--env KEY=VAL] ... -- <command> [args...]\n", argv[0]);
                exit(EXIT_FAILURE);
            default:
                // Should not happen with the current setup, but handle defensively
                 fprintf(stderr, "Usage: %s --rootfs <path> --cgroup-id <id> [--workdir <path>] [--mem <limit>] [--env KEY=VAL] ... -- <command> [args...]\n", argv[0]);
                exit(EXIT_FAILURE);
        }
    }

    // After the loop, optind points to the first non-option argument (the command)
    if (optind >= argc) {
        die("Missing required command after options (use '--' if command resembles an option)");
    }

    // Collect the command and its arguments
    for (int i = optind; i < argc; ++i) {
        args.cmd.push_back(argv[i]);
    }

    // ---- Validation of parsed arguments ----
    if (args.rootfs.empty()) die("Missing required argument: --rootfs");
    if (args.cmd.empty()) die("Missing required command after options"); // Should be caught above, but double-check
    if (args.cgroup_id.empty()) die("Missing required argument: --cgroup-id");
    if (args.workdir.empty()) {
        args.workdir = "/"; // Default workdir if not provided
        log_msg("Workdir not specified, defaulting to '/'");
    }
    // Check if rootfs path exists (basic check)
    struct stat st;
    if (stat(args.rootfs.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) {
        die(("Rootfs path specified is not a valid directory: " + args.rootfs).c_str());
    }
}

// --- Helper Functions ---

// Writes UID/GID maps for rootless operation.
// Maps the current host user/group to root (0) inside the container.
// WARNING: This is sensitive to kernel configuration and permissions.
void setup_user_namespace_mappings() {
    log_msg("Setting up user namespace mappings (simplified)...");
    uid_t host_uid = getuid();
    gid_t host_gid = getgid();
    int fd = -1;

    // --- Deny setgroups ---
    // REQUIRED for writing gid_map as an unprivileged user in the *parent* namespace
    // trying to map groups in the *child* namespace. Must happen *before* writing gid_map.
    errno = 0;
    fd = open("/proc/self/setgroups", O_WRONLY);
    if (fd >= 0) {
        if (write(fd, "deny", 4) == -1) {
            // Non-fatal warning if this fails (depends on kernel config)
             log_msg(("Warning: Failed to write 'deny' to /proc/self/setgroups: " + std::string(strerror(errno))).c_str());
        }
        close(fd);
    } else {
         // Non-fatal warning if file doesn't exist or can't be opened
         log_msg(("Warning: Could not open /proc/self/setgroups: " + std::string(strerror(errno))).c_str());
    }

    // --- Write UID Map ---
    // Format: container_uid host_uid range
    char uid_map_buf[100];
    snprintf(uid_map_buf, sizeof(uid_map_buf), "0 %d 1", host_uid);
    errno = 0;
    fd = open("/proc/self/uid_map", O_WRONLY);
    if (fd == -1) die("open /proc/self/uid_map");
    if (write(fd, uid_map_buf, strlen(uid_map_buf)) == -1) die("write /proc/self/uid_map");
    close(fd);
    log_msg("-> UID map written");

    // --- Write GID Map ---
    // Format: container_gid host_gid range
    char gid_map_buf[100];
    snprintf(gid_map_buf, sizeof(gid_map_buf), "0 %d 1", host_gid);
    errno = 0;
    fd = open("/proc/self/gid_map", O_WRONLY);
    if (fd == -1) die("open /proc/self/gid_map");
    if (write(fd, gid_map_buf, strlen(gid_map_buf)) == -1) die("write /proc/self/gid_map");
    close(fd);
    log_msg("-> GID map written");
}

// Sets up cgroups v2 using the unified hierarchy.
void setup_cgroups(const Args& args) {
    log_msg("Setting up cgroups v2...");
    std::string cgroup_base = "/sys/fs/cgroup"; // Assumes unified hierarchy mounted here
    std::string cgroup_path = cgroup_base + "/neoshell/" + args.cgroup_id;
    int fd = -1;

    // 1. Create cgroup directory (needs appropriate permissions)
    // Use mkdir directly instead of system(). Needs mode 0755 typically.
    errno = 0;
    // Create parent dir "neoshell" if it doesn't exist
    if (mkdir((cgroup_base + "/neoshell").c_str(), 0755) == -1 && errno != EEXIST) {
         log_msg(("Warning: Could not create parent cgroup dir " + cgroup_base + "/neoshell: " + std::string(strerror(errno))).c_str());
         // Attempt to continue, maybe only the leaf dir creation failed before
    }
    errno = 0; // Reset errno before the next mkdir
    if (mkdir(cgroup_path.c_str(), 0755) == -1) {
        // If it already exists, that's okay for reusing. Any other error is a problem.
        if (errno != EEXIST) {
            log_msg(("Warning: Failed to create cgroup directory " + cgroup_path + ": " + std::string(strerror(errno))).c_str());
            // Don't die, but log a warning. Resource limits might not apply.
        } else {
             log_msg(("-> Cgroup dir already exists: " + cgroup_path).c_str());
        }
    } else {
        log_msg(("-> Created cgroup dir: " + cgroup_path).c_str());
    }

    // 2. Apply resource limits (Memory)
    if (!args.mem_limit.empty()) {
        std::string mem_max_path = cgroup_path + "/memory.max";
        errno = 0;
        fd = open(mem_max_path.c_str(), O_WRONLY | O_TRUNC); // O_TRUNC ensures we overwrite
        if (fd == -1) {
             log_msg(("Warning: Could not open " + mem_max_path + ": " + std::string(strerror(errno))).c_str());
        } else {
            if (write(fd, args.mem_limit.c_str(), args.mem_limit.length()) == -1) {
                 log_msg(("Warning: Failed to write to " + mem_max_path + ": " + std::string(strerror(errno))).c_str());
            } else {
                 log_msg(("-> Set memory.max = " + args.mem_limit).c_str());
            }
            close(fd);
        }
    } else {
         log_msg("-> No memory limit specified.");
    }

    // TODO: Apply CPU limits (e.g., using cpu.max requires parsing format like "quota period")

    // 3. Add current process (PID 1 in the container) to the cgroup
    std::string procs_path = cgroup_path + "/cgroup.procs";
    errno = 0;
    fd = open(procs_path.c_str(), O_WRONLY);
     if (fd == -1) {
         log_msg(("Warning: Could not open " + procs_path + ": " + std::string(strerror(errno))).c_str());
     } else {
        pid_t pid = getpid(); // Get current process ID
        std::string pid_str = std::to_string(pid);
        if (write(fd, pid_str.c_str(), pid_str.length()) == -1) {
            log_msg(("Warning: Failed to write PID " + pid_str + " to " + procs_path + ": " + std::string(strerror(errno))).c_str());
        } else {
             log_msg(("-> Added PID " + pid_str + " to cgroup.procs").c_str());
        }
        close(fd);
     }

     log_msg("Cgroup setup finished (check warnings).");
}

// Sets up the container's filesystem using pivot_root.
void setup_filesystem(const Args& args) {
    log_msg("Setting up filesystem using pivot_root...");

    // Ensure rootfs path is absolute (simplifies pivot_root logic)
    // Note: Realpath might be better but adds complexity. Assume caller gives absolute enough path.

    // 1. Make host root mount private to prevent mount events propagation
    errno = 0;
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) == -1) {
        // This might fail if already private, non-fatal warning
        if (errno != EINVAL) { // EINVAL can mean it's already private/unbindable
             log_msg(("Warning: Failed to make host root mount private: " + std::string(strerror(errno))).c_str());
        }
    } else {
         log_msg("-> Made host root mount private.");
    }

    // 2. Bind mount the new rootfs onto itself (required by pivot_root if old/new are on same fs)
    errno = 0;
     if (mount(args.rootfs.c_str(), args.rootfs.c_str(), "bind", MS_BIND | MS_REC, NULL) == -1) {
         die(("bind mount failed for " + args.rootfs).c_str());
     }
     log_msg(("-> Bind mounted " + args.rootfs + " onto itself.").c_str());

    // 3. Create directory for old root *within* the new rootfs
    std::string put_old_path = args.rootfs + "/.old_root";
    errno = 0;
    if (mkdir(put_old_path.c_str(), 0700) == -1 && errno != EEXIST) { // Use 0700 for restricted access
        die(("mkdir .old_root failed in " + args.rootfs).c_str());
    }
    log_msg(("-> Ensured " + put_old_path + " exists.").c_str());

    // 4. Perform the pivot_root
    errno = 0;
    // pivot_root system call might not be in glibc headers depending on version
    #ifndef SYS_pivot_root
        // Check architecture! This is for x86_64. Use syscall(__NR_pivot_root, ...) with unistd.h if available.
        #if defined(__x86_64__)
            #define SYS_pivot_root 155
        #elif defined(__aarch64__)
             #define SYS_pivot_root 41 // Check man page for your arch
        #else
             #error "SYS_pivot_root syscall number not defined for this architecture"
        #endif
    #endif
    if (syscall(SYS_pivot_root, args.rootfs.c_str(), put_old_path.c_str()) == -1) {
        die("pivot_root failed");
    }
    log_msg("-> pivot_root successful.");

    // 5. Change directory to the *new* root (which is now "/")
    errno = 0;
    if (chdir("/") == -1) {
        die("chdir / failed after pivot_root");
    }
    log_msg("-> Changed directory to new root (/).");

    // 6. Unmount the old root to remove access to host filesystem
    // MNT_DETACH performs a lazy unmount.
    errno = 0;
    if (umount2("/.old_root", MNT_DETACH) == -1) {
        // Non-fatal warning, but means host fs might still be accessible
        log_msg(("Warning: umount2 /.old_root failed: " + std::string(strerror(errno))).c_str());
    } else {
        log_msg("-> Unmounted /.old_root.");
        // Optional: Remove the directory now it's unmounted
        errno = 0;
        if (rmdir("/.old_root") == -1) {
             log_msg(("Warning: rmdir /.old_root failed: " + std::string(strerror(errno))).c_str());
        }
    }

    // ---- Mount essential virtual filesystems inside the new root ----

    // 7. Mount /proc
    errno = 0;
    if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) == -1) {
        die("mount /proc failed");
    }
    log_msg("-> Mounted /proc.");

    // 8. Mount /dev (minimal tmpfs - populating needed nodes is advanced)
    errno = 0;
    // Use stricter options: noexec
    if (mount("tmpfs", "/dev", "tmpfs", MS_NOSUID | MS_STRICTATIME | MS_NOEXEC, "mode=755,size=65536k") == -1) {
         die("mount /dev tmpfs failed");
    }
    log_msg("-> Mounted tmpfs on /dev (limited size).");
    // TODO: Create essential device nodes in /dev: null, zero, random, urandom, tty, pts/ptmx
    // This typically requires mknod and correct permissions.

    // 9. Mount /sys (read-only for safety)
    errno = 0;
    if (mount("sysfs", "/sys", "sysfs", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) == -1) {
         // Usually needed, make it fatal if mount fails
         die("mount /sys failed");
    } else {
        log_msg("-> Mounted /sys (read-only).");
    }

    log_msg("Filesystem setup finished.");
}


// --- Main Execution ---
int main(int argc, char* argv[]) {
    Args args;
    errno = 0; // Clear errno before parsing potentially bad args
    parse_args(argc, argv, args);

    // Use log_msg for all sandbox output
    log_msg("--- Neoshell Sandbox Starting ---");
    log_msg(("RootFS: " + args.rootfs).c_str());
    log_msg(("Workdir: " + args.workdir).c_str());
    std::string cmd_str;
    for(const auto& p : args.cmd) { cmd_str += p + " "; } // Construct command string for logging
    log_msg(("Command: " + cmd_str).c_str());
    log_msg(("Cgroup ID: " + args.cgroup_id).c_str());
    log_msg(("Memory Limit: " + (args.mem_limit.empty() ? "(default)" : args.mem_limit)).c_str());
    log_msg(("Host UID: " + std::to_string(getuid()) + ", Host GID: " + std::to_string(getgid())).c_str());

    // --- Stage 1: Create User Namespace ---
    log_msg("Entering Stage 1: Creating User Namespace...");
    errno = 0;
    // CLONE_NEWUSER must often be the *first* flag used when calling unshare as non-root
    if (unshare(CLONE_NEWUSER) == -1) {
        die("unshare CLONE_NEWUSER failed. Check kernel config (CONFIG_USER_NS=y) and permissions (/proc/sys/user/max_user_namespaces).");
    }
    log_msg("-> User namespace created. Process now has root privileges *within* this namespace.");

    // Setup UID/GID mapping. This happens *after* CLONE_NEWUSER.
    // The process writing the map needs privileges over the namespace (which it has now).
    setup_user_namespace_mappings();


    // --- Stage 2: Create Other Namespaces and Setup Environment ---
    // Now that we are root in the user namespace, we can create other namespaces.
    log_msg("Entering Stage 2: Setting up other namespaces and environment...");

    // Unshare other namespaces
    errno = 0;
    if (unshare(CLONE_NEWPID | CLONE_NEWNS | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWCGROUP) == -1) {
        die("unshare (PID, NS, UTS, IPC, CGROUP) failed");
    }
    log_msg("-> PID, Mount, UTS, IPC, Cgroup namespaces created.");

    // Set hostname inside the new UTS namespace
    errno = 0;
    // Use a simple default hostname if needed, perhaps based on cgroup_id
    std::string hostname = args.cgroup_id.substr(0, 63); // Limit hostname length
    if (sethostname(hostname.c_str(), hostname.length()) == -1) {
         log_msg(("Warning: sethostname failed: " + std::string(strerror(errno))).c_str());
    } else {
        log_msg(("-> Set container hostname to " + hostname).c_str());
    }

    // ---- Fork here to become PID 1 in the new PID namespace ----
    // The child process will continue with setup and execve.
    // The parent process will wait for the child and exit with its status.
    log_msg("Forking to create PID 1 process...");
    errno = 0;
    pid_t child_pid = fork();
    if (child_pid == -1) {
        die("fork failed after namespace creation");
    }

    if (child_pid != 0) {
        // --- Parent Process ---
        log_msg(("Parent (PID " + std::to_string(getpid()) + "): Waiting for child (PID " + std::to_string(child_pid) + ")").c_str());
        int status;
        errno = 0;
        if (waitpid(child_pid, &status, 0) == -1) {
            // Don't use die() here, just report error and exit
            fprintf(stderr, "[nsi-sandbox] Parent: waitpid failed: %s\n", strerror(errno));
            exit(EXIT_FAILURE);
        }
        log_msg(("Parent: Child exited with status " + std::to_string(WEXITSTATUS(status))).c_str());
        // Exit with the same status code as the child (container)
        exit(WEXITSTATUS(status));

    } else {
        // --- Child Process (becomes PID 1 in the container) ---
        log_msg(("Child (PID " + std::to_string(getpid()) + ", should be PID 1 in container): Continuing setup...").c_str());

        // Setup Cgroups (Add *this* process, the child, to the cgroup)
        setup_cgroups(args);

        // Setup Filesystem (pivot_root or chroot, mount /proc, etc.)
        setup_filesystem(args);

        // Change to working directory *inside* the new root
        errno = 0;
        if (chdir(args.workdir.c_str()) == -1) {
            die(("chdir to workdir failed: " + args.workdir).c_str());
        }
        log_msg(("-> Changed to working directory: " + args.workdir).c_str());

        // Prepare command arguments for execve
        std::vector<char*> cmd_argv;
        for (const auto& s : args.cmd) {
            cmd_argv.push_back(const_cast<char*>(s.c_str()));
        }
        cmd_argv.push_back(nullptr); // Null-terminate the argument list

        // Prepare environment variables for execve
        clearenv(); // Start with a clean environment
        std::vector<char*> envp;
        // Using static is simple but not thread-safe (not an issue here as we exec immediately)
        static std::vector<std::string> env_storage;
        env_storage.clear(); // Clear from previous runs if static
        for(const auto& pair : args.env_vars) {
            env_storage.push_back(pair.first + "=" + pair.second);
            envp.push_back(const_cast<char*>(env_storage.back().c_str()));
        }
        // Add minimal required PATH if not set by user? Better to rely on image.
        if (args.env_vars.find("PATH") == args.env_vars.end()) {
             env_storage.push_back("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
             envp.push_back(const_cast<char*>(env_storage.back().c_str()));
             log_msg("-> Setting default PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        }
        // Add container indicator
        env_storage.push_back("NEOSHELL_CONTAINER=true");
        envp.push_back(const_cast<char*>(env_storage.back().c_str()));
        // Add hostname
        env_storage.push_back("HOSTNAME=" + hostname);
        envp.push_back(const_cast<char*>(env_storage.back().c_str()));

        envp.push_back(nullptr); // Null-terminate the environment list

        // --- Stage 3: Execute the Target Command ---
        log_msg("Entering Stage 3: Executing command...");
        log_msg(("-> execve: " + std::string(cmd_argv[0])).c_str());

        // Clear errno before execve, as it only returns on error.
        errno = 0;
        if (execve(cmd_argv[0], cmd_argv.data(), envp.data()) == -1) {
            // If execve returns, it failed. Errno is set.
            die(("execve failed for '" + std::string(cmd_argv[0]) + "'").c_str());
        }

        // Should never reach here if execve succeeds
        log_msg("Error: execve returned, which should not happen on success.");
        return EXIT_FAILURE; // Exit child process with failure
    }
}