#!/bin/sh
# Send only the operational alert to the explicitly configured recipient.
set -eu
umask 077
state=$1
message=$2
settings="$state/operations.plist"
field() { /usr/bin/plutil -extract "$1" raw -o - "$settings"; }
[ "$(field alertEnabled)" = true ] || exit 0
credentials=$(field alertCredentials)
recipient=$(field alertRecipient)
work=$(/usr/bin/mktemp -d)
trap '/bin/rm -rf "$work"' EXIT HUP INT TERM
/usr/bin/curl --fail --silent --show-error --max-time 15 -H 'Content-Type: application/json' --data-binary "@$credentials" https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal > "$work/auth.json" 2> "$work/error" || exit 1
[ "$(/usr/bin/plutil -extract code raw -o - "$work/auth.json")" = 0 ] || exit 1
access=$(/usr/bin/plutil -extract tenant_access_token raw -o - "$work/auth.json")
printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$access" > "$work/headers"
unset access
/usr/bin/plutil -create xml1 "$work/content.plist"
/usr/bin/plutil -insert text -string "$message" "$work/content.plist"
/usr/bin/plutil -convert json -o "$work/content.json" "$work/content.plist"
content=$(/bin/cat "$work/content.json")
/usr/bin/plutil -create xml1 "$work/request.plist"
/usr/bin/plutil -insert receive_id -string "$recipient" "$work/request.plist"
/usr/bin/plutil -insert msg_type -string text "$work/request.plist"
/usr/bin/plutil -insert content -string "$content" "$work/request.plist"
/usr/bin/plutil -convert json -o "$work/request.json" "$work/request.plist"
/usr/bin/curl --fail --silent --show-error --max-time 15 --header "@$work/headers" --data-binary "@$work/request.json" 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id' > "$work/result.json" 2> "$work/error" || exit 1
[ "$(/usr/bin/plutil -extract code raw -o - "$work/result.json")" = 0 ] || exit 1
exit 0
