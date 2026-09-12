#include <sys/prctl.h>
#include <unistd.h>

__attribute__((constructor)) static void disable_core_dump(void) {
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) == -1) {
    _exit(125);
  }
}
