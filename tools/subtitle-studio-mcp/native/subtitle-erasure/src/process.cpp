#include "process.hpp"

#include <cerrno>
#include <chrono>
#include <csignal>
#include <spawn.h>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>

extern char** environ;

namespace convax::subtitle_erasure {
namespace {

[[nodiscard]] int wait_for_child(pid_t child,
                                 const std::atomic_bool& cancelled) {
  int status = 0;
  bool termination_sent = false;
  auto termination_deadline = std::chrono::steady_clock::time_point::max();

  while (true) {
    const pid_t result = ::waitpid(child, &status, WNOHANG);
    if (result == child) {
      break;
    }
    if (result < 0 && errno != EINTR) {
      throw std::system_error(errno, std::generic_category(), "waitpid failed");
    }

    if (cancelled.load(std::memory_order_relaxed) && !termination_sent) {
      static_cast<void>(::kill(-child, SIGTERM));
      termination_sent = true;
      termination_deadline =
          std::chrono::steady_clock::now() + std::chrono::seconds(1);
    } else if (termination_sent &&
               std::chrono::steady_clock::now() >= termination_deadline) {
      static_cast<void>(::kill(-child, SIGKILL));
      termination_deadline = std::chrono::steady_clock::time_point::max();
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }

  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  }
  if (WIFSIGNALED(status)) {
    return 128 + WTERMSIG(status);
  }
  return 255;
}

}  // namespace

int run_process(const std::filesystem::path& executable,
                const std::vector<std::string>& arguments,
                const std::atomic_bool& cancelled) {
  if (cancelled.load(std::memory_order_relaxed)) {
    return 130;
  }

  std::vector<std::string> argument_storage;
  argument_storage.reserve(arguments.size() + 1U);
  argument_storage.push_back(executable.string());
  argument_storage.insert(argument_storage.end(), arguments.begin(),
                          arguments.end());

  std::vector<char*> argument_vector;
  argument_vector.reserve(argument_storage.size() + 1U);
  for (std::string& argument : argument_storage) {
    argument_vector.push_back(argument.data());
  }
  argument_vector.push_back(nullptr);

  posix_spawn_file_actions_t actions;
  int error = ::posix_spawn_file_actions_init(&actions);
  if (error != 0) {
    throw std::system_error(error, std::generic_category(),
                            "posix_spawn file actions init failed");
  }

  error = ::posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null",
                                              O_RDONLY, 0);
  if (error != 0) {
    static_cast<void>(::posix_spawn_file_actions_destroy(&actions));
    throw std::system_error(error, std::generic_category(),
                            "posix_spawn stdin redirect failed");
  }

  posix_spawnattr_t attributes;
  error = ::posix_spawnattr_init(&attributes);
  if (error != 0) {
    static_cast<void>(::posix_spawn_file_actions_destroy(&actions));
    throw std::system_error(error, std::generic_category(),
                            "posix_spawn attributes init failed");
  }
  error = ::posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP);
  if (error == 0) {
    error = ::posix_spawnattr_setpgroup(&attributes, 0);
  }
  if (error != 0) {
    static_cast<void>(::posix_spawnattr_destroy(&attributes));
    static_cast<void>(::posix_spawn_file_actions_destroy(&actions));
    throw std::system_error(error, std::generic_category(),
                            "posix_spawn process group setup failed");
  }

  pid_t child = 0;
  if (executable.has_parent_path()) {
    error = ::posix_spawn(&child, executable.c_str(), &actions, &attributes,
                          argument_vector.data(), environ);
  } else {
    error = ::posix_spawnp(&child, executable.c_str(), &actions, &attributes,
                           argument_vector.data(), environ);
  }
  static_cast<void>(::posix_spawnattr_destroy(&attributes));
  static_cast<void>(::posix_spawn_file_actions_destroy(&actions));
  if (error != 0) {
    throw std::system_error(error, std::generic_category(),
                            "failed to start ffmpeg");
  }
  return wait_for_child(child, cancelled);
}

}  // namespace convax::subtitle_erasure
