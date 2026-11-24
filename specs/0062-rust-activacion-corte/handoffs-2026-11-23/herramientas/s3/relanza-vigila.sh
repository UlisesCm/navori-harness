#!/usr/bin/env bash
# Waits for the running s3-vigila unit to finish its rounds, then starts it again (6 rounds).
# Does not relaunch after an anomaly (exit 4): that one needs a cause first.
set -u
cd "$HOME/.cache/navori-rust/s3/r81"
while systemctl --user is-active -q s3-vigila; do sleep 60; done
if tail -1 vigila-loop.log | grep -q '^ANOMALY'; then
  echo "$(date '+%F %T') s3-vigila ended with ANOMALY; not relaunched" >> relanza-vigila.log
  exit 4
fi
systemd-run --user --unit s3-vigila --collect -p WorkingDirectory="$PWD" -E PATH="$PATH" -E HOME="$HOME" \
  /bin/bash -c "exec ./vigila-loop.sh 6 >> vigila-loop.out 2>&1" >> relanza-vigila.log 2>&1
echo "$(date '+%F %T') s3-vigila relaunched (6 rounds), exit=$?" >> relanza-vigila.log
