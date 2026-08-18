#ifndef OUTPOST_WEBSOCKET_H
#define OUTPOST_WEBSOCKET_H

#include "session.h"

struct outpost_control_plane;

int outpost_websocket_start(outpost_session_t* session,
                            struct outpost_control_plane* cp);

#endif
