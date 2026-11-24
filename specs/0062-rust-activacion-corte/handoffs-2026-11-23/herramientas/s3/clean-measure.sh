# Shared helpers for S3 unattended measurements. Source it; needs $O (output dir) and fd 9 = heavy flock.
# measure <label> <cmd...>: waits for load < 3.5, takes the flock only for the measurement,
# records start/end load plus the CPU used by everything outside this script's process tree,
# and repeats (up to MAX_TRIES) while the run was dirtied by foreign load.
MAX_TRIES=${MAX_TRIES:-8}
FOREIGN_MAX=${FOREIGN_MAX:-2.0}   # average foreign cores allowed during the measurement
HZ=$(getconf CLK_TCK)
export LC_NUMERIC=C

load1() { cut -d' ' -f1 /proc/loadavg; }
quiet() { until awk -v l="$(load1)" 'BEGIN{exit !(l<3.5)}'; do sleep 30; done; }
busy_jiffies() { awk '/^cpu /{print $2+$3+$4+$7+$8+$9}' /proc/stat; }
own_jiffies() { awk '{print $14+$15+$16+$17}' /proc/$$/stat; }

# measure <label> <end_load_check:yes|no> <cmd...>
measure() {
  local label=$1 endcheck=$2; shift 2
  local try=1
  while [ $try -le $MAX_TRIES ]; do
    quiet; flock 9; quiet
    local t0 b0 o0 l0 t1 b1 o1 l1 rc
    t0=$(date +%s.%N); b0=$(busy_jiffies); o0=$(own_jiffies); l0=$(cut -d' ' -f1-3 /proc/loadavg)
    echo "$label try=$try start=$(date -Is) load=$l0" >> $O/env.txt
    "$@"; rc=$?
    t1=$(date +%s.%N); b1=$(busy_jiffies); o1=$(own_jiffies); l1=$(cut -d' ' -f1-3 /proc/loadavg)
    flock -u 9
    local foreign verdict=clean
    foreign=$(awk -v b=$((b1-b0)) -v o=$((o1-o0)) -v w="$(awk -v a=$t0 -v z=$t1 'BEGIN{print z-a}')" -v hz=$HZ \
      'BEGIN{f=(b-o)/hz/w; if(f<0)f=0; printf "%.2f", f}')
    awk -v f=$foreign -v m=$FOREIGN_MAX 'BEGIN{exit !(f>m)}' && verdict=dirty
    [ $rc = 75 ] && verdict=dirty   # the command itself reported a non-comparable run
    if [ "$endcheck" = yes ] && awk -v l="${l1%% *}" 'BEGIN{exit !(l>=3.5)}'; then verdict=dirty; fi
    echo "$label try=$try end=$(date -Is) load=$l1 rc=$rc foreign_cores=$foreign verdict=$verdict" >> $O/env.txt
    [ $verdict = clean ] && return 0
    try=$((try+1)); sleep 60
  done
  echo "$label FAILED: dirty after $MAX_TRIES tries" >> $O/env.txt
  return 1
}
