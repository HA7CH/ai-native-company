#!/bin/sh
# Independent of Node. The settings file contains paths only, never credentials.
set -eu
umask 077
state=$1
settings="$state/operations.plist"
field() { /usr/bin/plutil -extract "$1" raw -o - "$settings"; }
vault=$(field vault)
enabled=$(field syncEnabled)
[ "$enabled" = true ] || exit 0
status_file="$state/sync-status.json"
record() {
  printf '{"status":"%s","code":"%s","at":%s}\n' "$1" "$2" "$(/bin/date +%s)" > "$status_file.tmp"
  /bin/chmod 600 "$status_file.tmp"
  /bin/mv -f "$status_file.tmp" "$status_file"
}
if ! /bin/mkdir "$state/sync.lock" 2>/dev/null; then record blocked LOCKED; exit 0; fi
trap '/bin/rm -f "$state/sync.lock/pid"; /bin/rmdir "$state/sync.lock" 2>/dev/null || true' EXIT HUP INT TERM
printf '%s\n' "$$" > "$state/sync.lock/pid"
export GIT_TERMINAL_PROMPT=0
dirty=$(/usr/bin/git -C "$vault" status --porcelain 2> "$state/sync-error.log") || { record failed GIT_UNAVAILABLE; exit 0; }
if [ -n "$dirty" ]; then record blocked DIRTY; exit 0; fi
upstream=$(/usr/bin/git -C "$vault" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null) || { record blocked NO_UPSTREAM; exit 0; }
case "$upstream" in origin/*) ;; *) record blocked UNSUPPORTED_REMOTE; exit 0;; esac
if ! /usr/bin/git -C "$vault" -c credential.interactive=false -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 -c core.hooksPath=/dev/null fetch --quiet origin 2> "$state/sync-error.log"; then record failed FETCH_FAILED; exit 0; fi
if ! /usr/bin/git -C "$vault" -c core.hooksPath=/dev/null merge --ff-only --no-edit "$upstream" > "$state/sync-output.log" 2> "$state/sync-error.log"; then record failed NOT_FAST_FORWARD; exit 0; fi
/bin/chmod 600 "$state/sync-output.log" "$state/sync-error.log"
/bin/date +%s > "$state/last-sync-ok.tmp"
/bin/chmod 600 "$state/last-sync-ok.tmp"
/bin/mv -f "$state/last-sync-ok.tmp" "$state/last-sync-ok"
record current OK
exit 0
