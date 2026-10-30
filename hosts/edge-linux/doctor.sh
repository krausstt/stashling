#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# What to test, as something you can actually run.
#
#   sudo ./doctor.sh
#
# Every check below exists because the thing it checks fails SILENTLY. That is the organising
# principle: this box's whole failure mode is looking healthy. Chrome starts, the unit is
# green, the timer fires, the sweep reports success -- and the data is a login page, or 7% of
# a list, or a month stale. None of that produces an error anywhere.
#
# Exit codes:  0 everything passed   1 something failed   2 only warnings

set -uo pipefail

STASH_USER="${STASH_USER:-stashling}"
STASH_HOME="${STASH_HOME:-/var/lib/stashling}"
STASH_OPT="${STASH_OPT:-/opt/stashling}"
STASH_ETC="${STASH_ETC:-/etc/stashling}"
DISPLAY_NUM="${DISPLAY_NUM:-1}"
PROFILE="$STASH_HOME/chrome-profile"

pass=0; fail=0; warnings=0; n=0

_h()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
_ok() { n=$((n+1)); pass=$((pass+1)); printf ' \033[32m%2d PASS\033[0m  %s\n' "$n" "$*"; }
_no() { n=$((n+1)); fail=$((fail+1)); printf ' \033[31m%2d FAIL\033[0m  %s\n' "$n" "$1"; shift; [[ $# -gt 0 ]] && printf '         \033[2m%s\033[0m\n' "$*"; }
_wa() { n=$((n+1)); warnings=$((warnings+1)); printf ' \033[33m%2d WARN\033[0m  %s\n' "$n" "$1"; shift; [[ $# -gt 0 ]] && printf '         \033[2m%s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run with sudo (it reads a profile owned by $STASH_USER)"; exit 1; }

# ── the machine ─────────────────────────────────────────────────────────────────────────────

_h "the machine"

. /etc/os-release 2>/dev/null || true
[[ "${VERSION_ID:-}" == "24.04" ]] \
  && _ok "Ubuntu 24.04 LTS" \
  || _wa "not Ubuntu 24.04 (found ${PRETTY_NAME:-unknown})" "untested, but probably fine"

if command -v google-chrome-stable >/dev/null; then
  CV="$(dpkg-query -W -f='${Version}' google-chrome-stable 2>/dev/null)"
  _ok "google-chrome-stable $CV"
  apt-mark showhold 2>/dev/null | grep -qx 'google-chrome-stable' \
    && _ok "chrome is held (upgrades are a deliberate, observed event)" \
    || _wa "chrome is NOT held" "a major version ships roughly every 2 weeks since Chrome 153, and an unattended upgrade swaps the binary under the running browser without restarting it"
else
  _no "google-chrome-stable is not installed"
fi

# The upgrade that already happened. dpkg replaces the binary in place and nothing restarts the
# browser, so it keeps running on a deleted inode -- for hours or days -- and then a newly
# spawned child execs the NEW binary against the OLD browser. Comparing `google-chrome
# --version` to dpkg can never catch this: that command launches the new on-disk binary and
# always agrees. /proc/PID/exe is the only honest witness.
if pgrep -f '^/opt/google/chrome/chrome' >/dev/null 2>&1; then
  stale=0
  for p in $(pgrep -f '^/opt/google/chrome/chrome'); do
    readlink "/proc/$p/exe" 2>/dev/null | grep -q '(deleted)' && stale=1
  done
  [[ $stale -eq 0 ]] \
    && _ok "the running Chrome is the Chrome on disk" \
    || _no "Chrome was upgraded under the running browser" "systemctl restart stashling-chrome.service, then re-run one sweep by hand"
fi

USERNS="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"
if [[ "$USERNS" == "1" ]]; then
  { [[ -e /etc/apparmor.d/chrome ]] || aa-status 2>/dev/null | grep -q chrome; } \
    && _ok "apparmor restricts unprivileged userns, and a chrome profile grants it" \
    || _wa "apparmor restricts unprivileged userns and no chrome profile was found" "Chrome's sandbox may be degraded. Check chrome://sandbox. Do NOT 'fix' this with --no-sandbox."
else
  _ok "apparmor userns restriction: $USERNS"
fi

grep -q -- '--no-sandbox' /etc/systemd/system/stashling-chrome.service 2>/dev/null \
  && _no "the Chrome unit passes --no-sandbox" "that is not a fix. Remove it and solve the AppArmor profile instead." \
  || _ok "no --no-sandbox anywhere in the unit"

if command -v node >/dev/null && node -e 'const[a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=4)?0:1)' 2>/dev/null; then
  node -e 'process.exit(typeof WebSocket==="function"?0:1)' \
    && _ok "node $(node -p 'process.versions.node') with a built-in WebSocket" \
    || _no "node has no global WebSocket" "the driver cannot speak CDP without it"
else
  _no "node is missing or older than 22.4" "Ubuntu's own nodejs package is Node 18 and will not do"
fi

# ── the services ────────────────────────────────────────────────────────────────────────────

_h "the services"

for u in stashling-display stashling-wm stashling-chrome; do
  systemctl is-active --quiet "$u.service" \
    && _ok "$u is active" \
    || _no "$u is NOT active" "journalctl -u $u -n 50 --no-pager"
done

if DISPLAY=":$DISPLAY_NUM" sudo -u "$STASH_USER" xdpyinfo >/dev/null 2>&1; then
  geo="$(DISPLAY=":$DISPLAY_NUM" sudo -u "$STASH_USER" xdpyinfo | awk '/dimensions:/{print $2; exit}')"
  _ok "display :$DISPLAY_NUM answers, $geo"
  h="${geo#*x}"
  [[ "${h%%[^0-9]*}" -ge 1600 ]] 2>/dev/null \
    && _ok "the screen is tall enough for a virtualized list ($geo)" \
    || _wa "the screen is short ($geo)" "a short viewport means many more scroll steps and a longer window in which the auto-scroll can mistake a slow row for the end of the list"
else
  _no "display :$DISPLAY_NUM does not answer" "systemctl status stashling-display"
fi

DISPLAY=":$DISPLAY_NUM" sudo -u "$STASH_USER" sh -c 'command -v xprop >/dev/null && xprop -root _NET_SUPPORTING_WM_CHECK' 2>/dev/null | grep -q 'window id' \
  && _ok "a window manager is running on :$DISPLAY_NUM" \
  || _wa "no window manager detected on :$DISPLAY_NUM" "Chrome runs without one, but --window-size and maximise silently do nothing, so your geometry becomes whatever Chrome picked"

# ── the two listening sockets, which are the whole security surface ─────────────────────────

_h "listening sockets"

VNC_PORT=$((5900 + DISPLAY_NUM))
vnc_line="$(ss -ltnH "sport = :$VNC_PORT" 2>/dev/null)"
if [[ -z "$vnc_line" ]]; then
  _wa "nothing is listening on $VNC_PORT" "the display service may be down"
elif grep -qE '127\.0\.0\.1:|\[::1\]:' <<<"$vnc_line"; then
  _ok "VNC on $VNC_PORT is bound to localhost only"
else
  _no "VNC on $VNC_PORT is listening beyond localhost" \
      "VncAuth is an unrate-limited shared secret of which only the first 8 characters count, in front of every session cookie you own. Add -localhost to the unit."
fi

PORT=""
if [[ -s "$PROFILE/DevToolsActivePort" ]]; then
  PORT="$(head -n1 "$PROFILE/DevToolsActivePort")"
  _ok "DevToolsActivePort says port $PORT"
else
  _no "no DevToolsActivePort in $PROFILE" \
      "since Chrome 136 a branded build SILENTLY ignores --remote-debugging-port when --user-data-dir is the default one. There is no error message for this."
fi

if [[ -n "$PORT" ]]; then
  dt_line="$(ss -ltnH "sport = :$PORT" 2>/dev/null)"
  if [[ -z "$dt_line" ]]; then
    _no "nothing is listening on $PORT" "DevToolsActivePort is not removed on an unclean exit, so it goes stale and keeps naming a dead port"
  elif grep -qE '127\.0\.0\.1:|\[::1\]:' <<<"$dt_line"; then
    _ok "DevTools on $PORT is bound to localhost only"
  else
    _no "DevTools on $PORT is listening beyond localhost" "the DevTools port has NO authentication whatsoever"
  fi

  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 \
    && _ok "/json/version answers" \
    || _no "/json/version does not answer on $PORT" "stale port file, or Chrome is wedged"

  # DNS-rebinding guard: a browser on your LAN must not be able to reach this port by name.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H 'Host: evil.example.com' "http://127.0.0.1:$PORT/json/list" 2>/dev/null)"
  [[ "$code" != "200" ]] \
    && _ok "the Host-header check rejects a foreign Host (got $code)" \
    || _wa "/json/list answered 200 to Host: evil.example.com" "check for --remote-allow-origins in the unit; it is never needed here, because Node's built-in WebSocket sends no Origin at all"
fi

# ── the extension ───────────────────────────────────────────────────────────────────────────

_h "the extension"

# NOT "is the service worker running". An MV3 worker is terminated after ~30 s idle, so between
# sweeps it is almost always asleep and has no DevTools target at all -- an earlier version of
# this check therefore failed on a perfectly healthy box. Instead, ask the driver to reach the
# extension exactly the way a sweep does: open its page (which wakes the worker) and compare
# chrome.runtime.id with the id derived from the install path. One definition of "reachable",
# shared by the check and the thing it checks.
if [[ -n "$PORT" && -f "$STASH_ETC/stashling.json" ]] && command -v node >/dev/null; then
  ext_json="$(sudo -u "$STASH_USER" /usr/local/bin/node "$STASH_OPT/driver/collect.mjs" \
                --config "$STASH_ETC/stashling.json" --check-extension 2>&1 | tail -n1)"
  if grep -q '"ok":true' <<<"$ext_json"; then
    awake="$(grep -q '"wasAwake":true' <<<"$ext_json" && echo awake || echo 'asleep, woken by the check')"
    _ok "the Stashling extension answers ($awake)"
  else
    _no "the Stashling extension cannot be reached" \
        "$ext_json -- Open chrome://extensions over VNC. Since Chrome 134 an unpacked extension is enabled ONLY while the Developer mode switch is on; if someone turned it off, or clicked away the 'disable developer mode extensions' bubble, this is what it looks like."
  fi
else
  _wa "skipped the extension check" "it needs a live DevTools port and $STASH_ETC/stashling.json"
fi

[[ -d "$STASH_OPT/extension" ]] \
  && _ok "extension source at $STASH_OPT/extension" \
  || _no "no extension at $STASH_OPT/extension" "re-run bootstrap.sh"

if [[ -d "$STASH_OPT/extension" ]]; then
  owner="$(stat -c '%U' "$STASH_OPT/extension")"
  [[ "$owner" == "root" ]] \
    && _ok "the extension directory is not writable by $STASH_USER" \
    || _wa "the extension directory is owned by $owner" "an unpacked extension the browser's own user can rewrite is a browser that can rewrite its own privileges"
fi

# ── the profile: the thing that must survive ────────────────────────────────────────────────

_h "the profile"

if [[ -d "$PROFILE" ]]; then
  perm="$(stat -c '%a %U' "$PROFILE")"
  [[ "$perm" == "700 $STASH_USER" ]] \
    && _ok "profile is 0700 $STASH_USER" \
    || _wa "profile permissions are '$perm'" "this directory is a credential store: live cookies for every platform you logged into"
else
  _no "no profile at $PROFILE"
fi

grep -q -- '--password-store=basic' /etc/systemd/system/stashling-chrome.service 2>/dev/null \
  && _ok "the cookie-encryption backend is pinned (--password-store=basic)" \
  || _no "--password-store is not pinned in the unit" \
         "Chrome picks a backend at startup. If it picks a keyring on one boot and not the next, every cookie written under the old key becomes undecryptable and you are logged out of everything, with no error. This failure appears weeks later, after a reboot."

cookies="$PROFILE/Default/Cookies"
if [[ -f "$cookies" ]]; then
  sz="$(stat -c '%s' "$cookies")"
  age_d=$(( ( $(date +%s) - $(stat -c '%Y' "$cookies") ) / 86400 ))
  if [[ "$sz" -gt 40000 ]]; then
    _ok "cookie store is $((sz/1024)) KiB, last written ${age_d}d ago"
  else
    _wa "cookie store is only $((sz/1024)) KiB" "that usually means nothing has been logged in yet -- do the by-hand logins over VNC"
  fi
else
  _wa "no cookie store yet" "Chrome has not been logged into anything in this profile"
fi

exit_type="$(node -e '
  try{const p=require("fs").readFileSync(process.argv[1],"utf8");
      process.stdout.write(JSON.parse(p)?.profile?.exit_type??"unknown")}catch{process.stdout.write("unreadable")}
' "$PROFILE/Default/Preferences" 2>/dev/null)"
case "$exit_type" in
  Normal|SessionEnded) _ok "last shutdown was clean (exit_type=$exit_type)" ;;
  Crashed) _wa "last shutdown was NOT clean (exit_type=Crashed)" \
      "Chrome's cookie store commits on a 30-second timer, so a SIGKILL can discard up to half a minute of cookie writes. Check KillMode=mixed and TimeoutStopSec in the unit." ;;
  *) _wa "could not read exit_type ($exit_type)" "" ;;
esac

# ── the configuration ───────────────────────────────────────────────────────────────────────

_h "the configuration"

CFG="$STASH_ETC/stashling.json"
if [[ -f "$CFG" ]]; then
  problems="$(node -e '
    import("'"$STASH_OPT"'/driver/collect.mjs").then(async (m) => {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      const p = m.validateConfig(cfg)
      process.stdout.write(p.join("\n"))
    }).catch(e => process.stdout.write("could not validate: " + e.message))
  ' "$CFG" 2>/dev/null)"
  if [[ -z "$problems" ]]; then
    _ok "$CFG is valid"
  else
    _no "$CFG is not valid" "$problems"
  fi

  # minRows: 1 passes validation but asserts nothing. It is the placeholder the example ships
  # with, and leaving it is how the silent-truncation guard gets silently disabled.
  if grep -qE '"minRows"[[:space:]]*:[[:space:]]*1[[:space:]]*[,}]' "$CFG"; then
    _wa "at least one target still has minRows: 1" \
        "that is the shipped placeholder and it cannot detect a truncated capture. Run one sweep by hand and set it just under the row count you actually get."
  else
    _ok "every target has a real minRows"
  fi

  grep -q 'YOUR-HANDLE' "$CFG" \
    && _wa "a target still contains YOUR-HANDLE" "MakerWorld list URLs contain your own handle" \
    || true
else
  _no "no $CFG" "re-run bootstrap.sh"
fi

[[ -f /etc/opt/chrome/policies/managed/stashling.json ]] \
  && { [[ "$(stat -c '%U' /etc/opt/chrome/policies/managed/stashling.json)" == "root" ]] \
       && _ok "chrome policy is in place and root-owned" \
       || _no "chrome policy is writable by a non-root user" "the enforcement guarantee is void"; } \
  || _wa "no managed chrome policy" "tab discarding is then free to unload your logged-in tab; it keeps its title and favicon, so it looks healthy right up until it reloads into a login page"

# ── the schedule ────────────────────────────────────────────────────────────────────────────

_h "the schedule"

for t in stashling-collect.timer stashling-export.timer; do
  if systemctl is-enabled --quiet "$t" 2>/dev/null; then
    next="$(systemctl show "$t" -p NextElapseUSecRealtime --value 2>/dev/null)"
    _ok "$t is enabled (next: ${next:-unknown})"
  else
    _wa "$t is not enabled" "expected until you have finished the by-hand steps and set minRows"
  fi
done

last="$STASH_HOME/state/last-run.json"
if [[ -f "$last" ]]; then
  summary="$(node -e '
    const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const bad=(r.results||[]).filter(x=>!x.ok);
    const ageH=Math.round((Date.now()-Date.parse(r.at))/3600000);
    process.stdout.write(`${ageH}h ago, ${(r.results||[]).length-bad.length}/${(r.results||[]).length} ok`
      + (bad.length?` -- failing: ${bad.map(b=>b.name+":"+b.reason).join(", ")}`:""));
  ' "$last" 2>/dev/null)"
  if grep -q 'failing' <<<"$summary"; then
    _no "last sweep: $summary"
  else
    _ok "last sweep: $summary"
  fi
  # Staleness is its own failure. A box that stopped collecting three weeks ago has a green
  # unit, a healthy timer and a last-run.json that still parses.
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(Date.now()-Date.parse(r.at)>48*3600e3?1:0)' "$last" 2>/dev/null \
    || _wa "the last sweep is more than 48h old" "the timer may be firing into an already-active unit, which systemd will not restart and will not report"
else
  _wa "no sweep has run yet" "sudo -u $STASH_USER node $STASH_OPT/driver/collect.mjs --config $CFG"
fi

# A lock left by a killed sweep used to stop collection forever while every tick exited green.
# The driver now reclaims a stale lock itself; this is the human-visible half of that.
lockf="$STASH_HOME/state/collect.lock"
if [[ -f "$lockf" ]]; then
  lock_age_m=$(( ( $(date +%s) - $(stat -c '%Y' "$lockf") ) / 60 ))
  if systemctl is-active --quiet stashling-collect.service stashling-export.service 2>/dev/null; then
    _ok "a sweep is running right now (lock ${lock_age_m} min old)"
  elif [[ $lock_age_m -gt 25 ]]; then
    _wa "a ${lock_age_m}-minute-old collect.lock is left behind with no sweep running" \
        "the next sweep reclaims it automatically; if this repeats, a sweep keeps hanging -- journalctl -u stashling-collect"
  else
    _ok "no stale collect.lock"
  fi
else
  _ok "no collect.lock held"
fi

# ── housekeeping ────────────────────────────────────────────────────────────────────────────

_h "housekeeping"

avail_kb="$(df -Pk "$STASH_HOME" | awk 'NR==2{print $4}')"
[[ "$avail_kb" -gt 2097152 ]] \
  && _ok "$((avail_kb/1024/1024)) GiB free on $STASH_HOME" \
  || _wa "only $((avail_kb/1024)) MiB free on $STASH_HOME" "journald's effective rate limit scales with free disk, so logs start truncating as the disk fills"

if journalctl -u stashling-chrome.service --since -24h 2>/dev/null | grep -q 'Suppressed .* messages'; then
  _wa "journald dropped some Chrome log lines in the last 24h" "raise LogRateLimitBurst if you need a complete log"
else
  _ok "no journald suppression in the last 24h"
fi

# Scripts copied over SMB or OneDrive instead of cloned arrive with CRLF, and bash reports that
# as a missing interpreter rather than as a line-ending problem.
for f in "$STASH_OPT/driver/collect.mjs" /usr/local/libexec/stashling/wait-devtools; do
  [[ -f "$f" ]] && { grep -qU $'\r' "$f" 2>/dev/null \
    && _no "$f has CRLF line endings" "copy it with git, not over a Windows share" \
    || _ok "$(basename "$f") has unix line endings"; }
done

# ── verdict ─────────────────────────────────────────────────────────────────────────────────

printf '\n\033[1m%d checks: \033[32m%d passed\033[0m, \033[33m%d warnings\033[0m, \033[31m%d failed\033[0m\n' \
  "$n" "$pass" "$warnings" "$fail"

if [[ $fail -gt 0 ]]; then
  printf '\033[31mFix the failures before enabling the timers.\033[0m\n\n'; exit 1
elif [[ $warnings -gt 0 ]]; then
  printf '\033[33mUsable, but read the warnings -- every one of them is a silent failure mode.\033[0m\n\n'; exit 2
fi
printf '\033[32mHealthy.\033[0m\n\n'
