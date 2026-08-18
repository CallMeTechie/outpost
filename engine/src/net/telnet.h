#ifndef OUTPOST_TELNET_H
#define OUTPOST_TELNET_H

#include "session.h"

struct outpost_control_plane;

int outpost_telnet_start(outpost_session_t* session,
                         struct outpost_control_plane* cp);

void outpost_telnet_resize(outpost_session_t* session,
                           uint16_t cols, uint16_t rows);

#endif
