#!/bin/sh
# Independent monitor: shell + macOS utilities + curl; never invokes Node or anc.
set -eu
umask 077
state=$1
settings="$state/operations.plist"
field() { /usr/bin/plutil -extract "$1" raw -o - "$settings"; }
label=$(field gatewayLabel)
log=$(field gatewayLog)
expected=$(field projectCount)
target="gui/$(/usr/bin/id -u)/$label"
now=$(/bin/date +%s)
if ! /bin/mkdir "$state/watchdog.lock" 2>/dev/null; then exit 0; fi
work=$(/usr/bin/mktemp -d)
printf '%s\n' "$$" > "$state/watchdog.lock/pid"
completed=false
cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$code" -ne 0 ] || [ "$completed" != true ]; then
    printf '{"healthy":false,"code":"WATCHDOG_ERROR","at":%s}\n' "$(/bin/date +%s)" > "$state/watchdog-status.json"
  fi
  /bin/rm -rf "$work"
  /bin/rm -f "$state/watchdog.lock/pid"
  /bin/rmdir "$state/watchdog.lock" 2>/dev/null || true
  exit 0
}
trap cleanup EXIT HUP INT TERM
reason=OK
healthy=true
restart=false
if [ -f "$state/pending-deployment.json" ] || [ -f "$state/.anc.lock" ]; then completed=true; exit 0; fi
if /bin/launchctl print "$target" > "$work/job" 2> "$work/lookup-error"; then
  pid=$(/usr/bin/awk '/^[[:space:]]*pid = / {print $3; exit}' "$work/job")
  if [ -z "$pid" ] || ! /usr/bin/grep -q 'state = running' "$work/job"; then healthy=false; reason=GATEWAY_STOPPED; restart=true
  else
    /bin/sleep 2
    second=$(/bin/launchctl print "$target" 2>/dev/null | /usr/bin/awk '/^[[:space:]]*pid = / {print $3; exit}') || second=''
    if [ "$pid" != "$second" ]; then healthy=false; reason=UNSTABLE_PID
    elif ! /bin/kill -0 "$pid" 2>/dev/null; then healthy=false; reason=MISSING_PID; restart=true
    elif [ ! -r "$log" ]; then healthy=false; reason=NO_CONNECTION_EVIDENCE
    else
      connections=$(/usr/bin/awk -v pid="$pid" '
        /^anc:boot pid=/ {active=($0 == "anc:boot pid=" pid); n=0}
        active && /\[connected to wss:\/\// {n++}
        active && /\[disconnected to wss:\/\// {if(n>0)n--}
        END {print n+0}
      ' "$log")
      if [ "$connections" -lt "$expected" ]; then healthy=false; reason=CONNECTION_UNAVAILABLE; restart=true; fi
    fi
  fi
elif /usr/bin/grep -Fq "Could not find service \"$label\" in domain for user gui:" "$work/lookup-error"; then
  healthy=false; reason=SERVICE_NOT_LOADED
else healthy=false; reason=STATE_UNKNOWN
fi
if [ "$(field syncEnabled)" = true ]; then
  limit=$(field syncMaxAgeSeconds)
  last=0
  if [ -f "$state/last-sync-ok" ]; then last=$(/bin/cat "$state/last-sync-ok"); fi
  case "$last" in *[!0-9]*|'') last=0;; esac
  if [ $((now-last)) -gt "$limit" ] && [ "$healthy" = true ]; then healthy=false; reason=SYNC_STALE; fi
fi
if [ "$restart" = true ]; then
  # A gateway with an active harness descendant must not be killed by the monitor.
  busy=$(/bin/ps -axo pid=,ppid= | /usr/bin/awk -v root="${pid:-0}" '{parent[$1]=$2} END {for(p in parent) if(parent[parent[p]]==root){print 1; exit}}')
  if [ "$busy" = 1 ]; then reason=ACTIVE_TASK; restart=false; fi
fi
attempts="$state/watchdog-restarts"
if [ "$restart" = true ]; then
  if [ -f "$attempts" ]; then /usr/bin/awk -v since="$((now-3600))" '$1>=since' "$attempts" > "$work/attempts"; else : > "$work/attempts"; fi
  count=$(/usr/bin/wc -l < "$work/attempts" | /usr/bin/tr -d ' ')
  if [ "$count" -lt 2 ]; then
    printf '%s\n' "$now" >> "$work/attempts"
    /bin/mv -f "$work/attempts" "$attempts"
    /bin/launchctl kickstart -k "$target" > /dev/null 2>&1 || true
  else reason=RESTART_LIMIT; fi
fi
previous=UNKNOWN
[ ! -f "$state/watchdog-health" ] || previous=$(/bin/cat "$state/watchdog-health")
if [ "$healthy" = true ]; then
  if [ "$previous" != OK ] && [ "$previous" != UNKNOWN ]; then
    /bin/sh "$state/bin/anc-alert.sh" "$state" '公司机器人运行检查已恢复。消息回复能力仍以实际提问为准。' || true
  fi
else
  last_alert=0
  [ ! -f "$state/watchdog-last-alert" ] || last_alert=$(/bin/cat "$state/watchdog-last-alert")
  case "$last_alert" in *[!0-9]*|'') last_alert=0;; esac
  if [ $((now-last_alert)) -ge 7200 ]; then
    if /bin/sh "$state/bin/anc-alert.sh" "$state" "公司机器人运行检查异常：${reason}。请检查本机 anc status。"; then printf '%s\n' "$now" > "$state/watchdog-last-alert"; fi
  fi
fi
printf '%s\n' "$reason" > "$state/watchdog-health"
printf '{"healthy":%s,"code":"%s","at":%s}\n' "$healthy" "$reason" "$now" > "$state/watchdog-status.json.tmp"
/bin/mv -f "$state/watchdog-status.json.tmp" "$state/watchdog-status.json"
printf '%s %s\n' "$now" "$reason" >> "$state/logs/watchdog.log"
completed=true
exit 0
