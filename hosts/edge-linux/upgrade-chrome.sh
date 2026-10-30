#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Upgrade Chrome on purpose, with a smoke test and a way back.
#
#   sudo ./upgrade-chrome.sh            # upgrade to the current stable
#   sudo ./upgrade-chrome.sh --rollback # go back to the version this script last cached
#
# WHY THIS EXISTS RATHER THAN unattended-upgrades.
#
# Two bad options and this is the third. Letting Chrome upgrade unattended means the binary is
# replaced under a running browser that nothing restarts: it keeps going on a deleted inode for
# hours or days, and then a newly spawned child process execs the new binary against the old
# browser. Whatever breaks after that looks like a site change, not an upgrade. Pinning Chrome
# forever is worse: it is the internet-facing component on a machine holding live session
# cookies for every platform you use, there is no extended-stable channel on Linux, and since
# Chrome 153 a new MAJOR ships roughly every two weeks.
#
# So: held by default, released here, restarted cleanly, and immediately proved still working
# against a real page. A major version can change the markup a connector depends on, and the
# only honest way to find that out is to collect something.

set -euo pipefail

STASH_USER="${STASH_USER:-stashling}"
STASH_HOME="${STASH_HOME:-/var/lib/stashling}"
STASH_OPT="${STASH_OPT:-/opt/stashling}"
STASH_ETC="${STASH_ETC:-/etc/stashling}"
CACHE="${CACHE:-/var/cache/stashling}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCH="$(dpkg --print-architecture)"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()  { printf '   \033[32mok\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run this with sudo."
mkdir -p "$CACHE"

current() { dpkg-query -W -f='${Version}' google-chrome-stable 2>/dev/null; }

restart_and_prove() {
  say "restarting chrome"
  # SIGTERM, wait, and only then escalate. The unit's KillMode=mixed sends it to the browser
  # process alone so it can run its session-ending path; a SIGKILL here can discard up to 30
  # seconds of cookie writes, which is how a box "randomly gets logged out" a week later.
  systemctl restart stashling-chrome.service
  sleep 3
  systemctl is-active --quiet stashling-chrome.service || die "chrome did not come back up."
  ok "chrome restarted"

  say "doctor"
  "$HERE/doctor.sh" || true   # warnings are expected and informative; failures are printed

  say "smoke test: one real sweep"
  # This is the actual test. The unit being green proves Chrome started; only a sweep proves
  # the connectors still parse what this Chrome renders.
  if sudo -u "$STASH_USER" /usr/local/bin/node "$STASH_OPT/driver/collect.mjs" \
       --config "$STASH_ETC/stashling.json"; then
    ok "the sweep succeeded on $(current)"
    return 0
  fi
  return 1
}

if [[ "${1:-}" == "--rollback" ]]; then
  prev="$(cat "$CACHE/previous.version" 2>/dev/null || true)"
  [[ -n "$prev" ]] || die "no cached previous version in $CACHE/previous.version"
  deb="$CACHE/google-chrome-stable_${prev}_${ARCH}.deb"
  [[ -f "$deb" ]] || die "the cached .deb for $prev is gone. See the pool URL in GUIDE.md."
  say "rolling back to $prev"
  apt-mark unhold google-chrome-stable >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$deb"
  apt-mark hold google-chrome-stable >/dev/null
  restart_and_prove || die "the sweep still fails after rolling back -- the cause is not Chrome."
  exit 0
fi

BEFORE="$(current)"
say "currently $BEFORE"

# Cache the .deb we are about to leave behind. The apt INDEX only ever advertises one version,
# so once the new one lands `apt install google-chrome-stable=<old>` fails -- but the pool still
# has the file. Keeping a copy locally is the difference between a one-command rollback and an
# archaeology session at 1 a.m.
if [[ ! -f "$CACHE/google-chrome-stable_${BEFORE}_${ARCH}.deb" ]]; then
  url="https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${BEFORE}_${ARCH}.deb"
  curl -fsSL -o "$CACHE/google-chrome-stable_${BEFORE}_${ARCH}.deb" "$url" \
    && ok "cached the current .deb for rollback" \
    || printf '   \033[33m..\033[0m could not cache %s (rollback will need the pool URL)\n' "$BEFORE"
fi
echo "$BEFORE" > "$CACHE/previous.version"

say "upgrading"
apt-mark unhold google-chrome-stable >/dev/null
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --only-upgrade google-chrome-stable
apt-mark hold google-chrome-stable >/dev/null

AFTER="$(current)"
if [[ "$AFTER" == "$BEFORE" ]]; then
  ok "already current at $BEFORE -- nothing to do"
  exit 0
fi
ok "$BEFORE -> $AFTER"

if restart_and_prove; then
  echo "$AFTER" > "$CACHE/chrome.version"
  printf '\n\033[32mUpgraded to %s and proved it still collects.\033[0m\n\n' "$AFTER"
else
  printf '\n\033[1;31mThe sweep FAILED on %s.\033[0m\n' "$AFTER"
  printf 'That is what this script is for. Roll back with:\n\n    sudo %s --rollback\n\n' "$0"
  printf 'Then open an issue with the connector name and the failure reason -- a major Chrome\n'
  printf 'version changing the rendered markup is exactly the signal the project wants.\n\n'
  exit 1
fi
