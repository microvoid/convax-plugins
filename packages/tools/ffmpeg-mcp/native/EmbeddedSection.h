#ifndef CONVAX_EMBEDDED_SECTION_H
#define CONVAX_EMBEDDED_SECTION_H

#include <stddef.h>
#include <stdint.h>

const uint8_t *convax_embedded_ffmpeg(size_t *size);
const uint8_t *convax_embedded_ffmpeg_sha256(size_t *size);

#endif
