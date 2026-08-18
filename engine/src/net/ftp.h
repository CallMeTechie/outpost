#ifndef OUTPOST_FTP_H
#define OUTPOST_FTP_H

#include "session.h"

struct outpost_control_plane;

bool outpost_ftp_is_ftp_session(const outpost_session_t* session);

int outpost_ftp_start(outpost_session_t* session,
                      struct outpost_control_plane* cp);

#endif
