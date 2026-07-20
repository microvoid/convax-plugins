#include "EmbeddedSection.h"

#include <mach-o/getsect.h>
#include <mach-o/loader.h>

extern const struct mach_header_64 _mh_execute_header;

static const uint8_t *section(const char *name, size_t *size) {
  unsigned long section_size = 0;
  uint8_t *bytes = getsectiondata(
    &_mh_execute_header,
    "__DATA",
    name,
    &section_size
  );
  if (size != NULL) {
    *size = (size_t)section_size;
  }
  return bytes;
}

const uint8_t *convax_embedded_ffmpeg(size_t *size) {
  return section("__ffmpeg", size);
}

const uint8_t *convax_embedded_ffmpeg_sha256(size_t *size) {
  return section("__ffhash", size);
}
