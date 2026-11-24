#!/usr/bin/env bash
# Run a heavy command under the shared machine lock.
exec flock /tmp/navori-heavy.lock "$@"
