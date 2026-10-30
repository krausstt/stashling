#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Stand up a Stashling edge collector on Ubuntu Server 24.04 LTS.
#
#   sudo ./bootstrap.sh
#
# Idempotent: run it again after a change and it will converge. It never touches your Chrome
# profile, so re-running cannot log you out.
#
# WHAT THIS BUILDS
#
#   Xtigervnc on :1  ──  one X display, shared
#        │                   ├── a human, over an SSH tunnel, to log in and to take over
#        │                   └── the collector, on a timer
#        ├── openbox          (a window manager, so window sizing actually takes effect)
#        └── Google Chrome    one long-lived instance, one profile, logged in BY HAND
#                 │
#                 └── DevTools port on 127.0.0.1 ── driver/collect.mjs, run by a systemd timer
#
# WHAT IT DELIBERATELY DOES NOT DO
#
#   - It does not log you in anywhere, and it cannot. Every session on this box is one you
#     established by hand in the VNC window. That is the point of the design, not a limitation
#     of the script: see docs/decisions/0007-edge-collectors-optional-hub.md.
#   - It does not grant the extension's host permissions. `chrome.permissions.request()`
#     requires a real user gesture, and CDP's `userGesture: true` is a no-op in V8, so no
#     amount of automation can click that bubble. You grant it once, by hand.
#   - It does not solve CAPTCHAs, and nothing here should ever be extended to. When a challenge
#     appears the run stops and says so; you attach to the same live tab over VNC and finish it
#     yourself.
#   - It does not pass --no-sandbox. If Chrome's sandbox cannot start, this script tells you,
#     because "works, just unsandboxed" is the kind of fix that never gets revisited.

set -euo pipefail

# ── settings you may want to change ─────────────────────────────────────────────────────────

STASH_USER="${STASH_USER:-stashling}"
STASH_HOME="${STASH_HOME:-/var/lib/stashling}"
STASH_OPT="${STASH_OPT:-/opt/stashling}"
STASH_ETC="${STASH_ETC:-/etc/stashling}"
DISPLAY_NUM="${DISPLAY_NUM:-1}"          # VNC listens on 5900 + this
# Tall on purpose. A virtualized list materialises rows against the viewport, so a taller
# screen means fewer scroll iterations and a shorter window in which the auto-scroll can
# mistake a slow row for the end of the list. Pixels are cheap; a truncated harvest is not.
GEOMETRY="${GEOMETRY:-1920x2400}"
DEVTOOLS_PORT="${DEVTOOLS_PORT:-9222}"
# Needs >= 22.4 for the built-in WebSocket. Pinned, and checksum-verified below, so bump it on
# purpose: this box holds live session cookies, so a Node security release is worth taking.
# 22.23.4 is the security release of 2026-10-20; check https://nodejs.org/en/blog/vulnerability.
NODE_VERSION="${NODE_VERSION:-22.23.4}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m %s\n' "$*"; }
note() { printf '   \033[33m..\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. preflight ────────────────────────────────────────────────────────────────────────────

say "preflight"

[[ $EUID -eq 0 ]] || die "run this with sudo."

. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || note "this targets Ubuntu; found ID=${ID:-?}. Continuing, but untested."
[[ "${VERSION_ID:-}" == "24.04" ]] || note "this targets 24.04 LTS; found ${VERSION_ID:-?}. Continuing."
ok "${PRETTY_NAME:-unknown os}"

ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  amd64|arm64) ok "architecture $ARCH (Google ships Chrome for both)" ;;
  *) die "no Google Chrome build for $ARCH. This design needs branded Chrome." ;;
esac

[[ -f "$REPO/extension/manifest.json" ]] || die "cannot find the repo. Run this from a Stashling checkout."
ok "repo at $REPO"

# ── 1. packages ─────────────────────────────────────────────────────────────────────────────

say "packages"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# xdg-utils FIRST and explicitly: google-chrome-stable's postinst calls xdg-icon-resource and
# hard-fails without it, which on a minimal server image aborts the bootstrap halfway through.
APT_PKGS=(
  ca-certificates curl gnupg xz-utils
  xdg-utils fonts-liberation fonts-noto-color-emoji   # Chrome renders boxes with no fonts
  tigervnc-standalone-server tigervnc-common tigervnc-tools
  openbox x11-utils x11-xserver-utils
  dbus-x11
)
apt-get install -y -qq "${APT_PKGS[@]}"
ok "installed: ${APT_PKGS[*]}"

# `vncpasswd` is NOT in tigervnc-standalone-server or -common; Debian names it tigervncpasswd
# and ships it in tigervnc-tools. Probing rather than assuming, because a script that calls the
# wrong name fails with command-not-found after a successful-looking install.
VNCPASSWD="$(command -v tigervncpasswd || command -v vncpasswd || true)"
[[ -n "$VNCPASSWD" ]] || die "no tigervncpasswd/vncpasswd found after installing tigervnc-tools."
ok "vnc password tool: $VNCPASSWD"

XVNC="$(command -v Xtigervnc || command -v Xvnc || true)"
[[ -n "$XVNC" ]] || die "no Xtigervnc/Xvnc found after installing tigervnc-standalone-server."
ok "x server: $XVNC"

# ── 2. Google Chrome ────────────────────────────────────────────────────────────────────────

say "google chrome"

if ! command -v google-chrome-stable >/dev/null; then
  # Let the .deb own its own repo and keyring. Its postinst writes
  # /etc/apt/sources.list.d/google-chrome.sources and rewrites it on EVERY upgrade, so a
  # hand-written file at that path silently stops being yours and can leave apt failing with
  # NO_PUBKEY at some random future upgrade.
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/chrome.deb" \
    "https://dl.google.com/linux/direct/google-chrome-stable_current_${ARCH}.deb"
  apt-get install -y -qq "$tmp/chrome.deb"
  rm -rf "$tmp"
fi
CHROME_VER="$(dpkg-query -W -f='${Version}' google-chrome-stable)"
ok "google-chrome-stable $CHROME_VER"

# Chrome is the internet-facing component on a box that holds live session cookies, and since
# Chrome 153 a new MAJOR ships roughly every two weeks. So: held, but deliberately, with
# `upgrade-chrome.sh` as the supported way forward. An indefinite hold is not a security
# posture; a scheduled one with a smoke test after it is.
apt-mark hold google-chrome-stable >/dev/null
cat > /etc/apt/apt.conf.d/52-stashling-chrome-blacklist <<'EOF'
// Stashling: Chrome upgrades are a deliberate, observed event, never an unattended one.
// Upgrading swaps the binary under a running browser without restarting it, and a major
// version can change the markup every connector depends on. Use upgrade-chrome.sh.
Unattended-Upgrade::Package-Blacklist {
    "google-chrome-stable$";
};
EOF
ok "chrome held at $CHROME_VER (release with hosts/edge-linux/upgrade-chrome.sh)"

# Does Chrome's sandbox have what it needs? Ubuntu 24.04 restricts unprivileged user
# namespaces via AppArmor, which is exactly what the zygote sandbox uses. We report rather than
# "fix", because the usual fix is --no-sandbox and that is not a fix.
USERNS_RESTRICT="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 'absent')"
if [[ "$USERNS_RESTRICT" == "1" ]]; then
  if [[ -e /etc/apparmor.d/chrome ]] || aa-status 2>/dev/null | grep -q 'chrome'; then
    ok "apparmor userns restriction is on, and a chrome profile exists to grant it"
  else
    note "kernel.apparmor_restrict_unprivileged_userns=1 and no chrome AppArmor profile found."
    note "Chrome may fail to start its sandbox. doctor.sh checks this; do NOT add --no-sandbox."
  fi
else
  ok "apparmor userns restriction: $USERNS_RESTRICT"
fi

# ── 3. Node ─────────────────────────────────────────────────────────────────────────────────

say "node"

# Ubuntu 24.04's own `nodejs` package is Node 18: no global WebSocket, so the driver cannot
# speak CDP, and below this repo's declared floor anyway. Installed from the official tarball
# with its published checksum rather than by piping a third-party script into a root shell --
# on a machine that is about to hold every session cookie you own, `curl | sudo bash` is not a
# trade worth making.
need_node=1
if command -v node >/dev/null; then
  have="$(node -p 'process.versions.node')"
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=4)?0:1)'; then
    need_node=0; ok "node $have already present"
  else
    note "node $have is too old (need >= 22.4 for the built-in WebSocket)"
  fi
fi

if [[ $need_node -eq 1 ]]; then
  case "$ARCH" in amd64) nodearch=x64 ;; arm64) nodearch=arm64 ;; esac
  tmp="$(mktemp -d)"
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  tarball="node-v${NODE_VERSION}-linux-${nodearch}.tar.xz"
  curl -fsSL -o "$tmp/$tarball" "$base/$tarball"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  ( cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c - ) \
    || die "node tarball checksum mismatch -- refusing to install it."
  rm -rf "/opt/node-${NODE_VERSION}"
  mkdir -p "/opt/node-${NODE_VERSION}"
  tar -xJf "$tmp/$tarball" -C "/opt/node-${NODE_VERSION}" --strip-components=1
  ln -sfn "/opt/node-${NODE_VERSION}" /opt/node
  ln -sf /opt/node/bin/node /usr/local/bin/node
  rm -rf "$tmp"
  ok "node $(node -p 'process.versions.node') (checksum verified)"
fi

# ── 4. the user and its directories ─────────────────────────────────────────────────────────

say "user and directories"

if ! id -u "$STASH_USER" >/dev/null 2>&1; then
  # Home under /var/lib, NOT /home. That is what lets the unit set ProtectHome=yes: with the
  # profile under /home, ProtectHome makes the directory "inaccessible and empty", Chrome
  # cheerfully creates a FRESH profile inside the namespace with no logins in it, and discards
  # it at stop. You get a working browser and an empty collection.
  useradd --system --create-home --home-dir "$STASH_HOME" --shell /usr/sbin/nologin "$STASH_USER"
fi
ok "user $STASH_USER (home $STASH_HOME)"

install -d -o "$STASH_USER" -g "$STASH_USER" -m 0700 "$STASH_HOME/chrome-profile"
install -d -o "$STASH_USER" -g "$STASH_USER" -m 0700 "$STASH_HOME/.vnc"
install -d -o "$STASH_USER" -g "$STASH_USER" -m 0750 "$STASH_HOME/state"
install -d -o "$STASH_USER" -g "$STASH_USER" -m 0750 "$STASH_HOME/exports"
install -d -o root -g root -m 0755 "$STASH_OPT" "$STASH_ETC" /usr/local/libexec/stashling
ok "directories"

# The extension and the driver are installed read-only to the collector. An unpacked extension
# that the browser's own user can rewrite is a browser that can rewrite its own privileges.
rm -rf "$STASH_OPT/extension" "$STASH_OPT/driver"
cp -r "$REPO/extension" "$STASH_OPT/extension"
cp -r "$HERE/driver" "$STASH_OPT/driver"
chown -R root:root "$STASH_OPT"
chmod -R a-w "$STASH_OPT"
ok "extension and driver at $STASH_OPT (read-only to $STASH_USER)"

# ── 5. Chrome enterprise policy ─────────────────────────────────────────────────────────────

say "chrome policy"

# Policy, not command-line flags. The flags people reach for here
# (--disable-backgrounding-occluded-windows and friends) govern process priority and timer
# budgets; they do not stop a tab being DISCARDED, and discarding is the one that actually
# ruins this. A discarded tab keeps its title and favicon, so it looks healthy, and then
# reloads on next visit -- frequently into a logged-out page, at 3 a.m., silently.
#
# Owned by root and NOT writable by the browser's own user, or the guarantee is void.
install -d -o root -g root -m 0755 /etc/opt/chrome/policies/managed
cat > /etc/opt/chrome/policies/managed/stashling.json <<'EOF'
{
  "TabDiscardingExceptions": ["*"],
  "HighEfficiencyModeEnabled": false,
  "BatterySaverModeAvailability": 0,
  "MetricsReportingEnabled": false,
  "DefaultBrowserSettingEnabled": false,
  "PromotionalTabsEnabled": false,
  "BrowserSignin": 0,
  "SyncDisabled": true,
  "PasswordManagerEnabled": false
}
EOF
chmod 0644 /etc/opt/chrome/policies/managed/stashling.json
ok "policy written (verify at chrome://policy after Chrome restarts, never from the filesystem)"

# ── 6. VNC ──────────────────────────────────────────────────────────────────────────────────

say "vnc"

VNC_PORT=$((5900 + DISPLAY_NUM))

if [[ ! -s "$STASH_HOME/.vnc/passwd" ]]; then
  # Interactive on purpose: a password baked into a bootstrap script ends up in shell history,
  # in your terminal scrollback, and eventually in a git repo.
  #
  # Be aware of what this secret is worth and what it is not. VncAuth is an obfuscated shared
  # secret with NO rate limiting, and only the FIRST 8 CHARACTERS are ever significant -- a
  # 32-character "strong" passphrase is theatre. It is a speed bump in front of an SSH tunnel,
  # not a lock. That is why the server binds to localhost below.
  echo
  echo "   Set a VNC password. Only the first 8 characters count."
  "$VNCPASSWD" -f > "$STASH_HOME/.vnc/passwd" < /dev/tty
  [[ -s "$STASH_HOME/.vnc/passwd" ]] || die "empty VNC password file -- that would authenticate anyone."
  chown "$STASH_USER:$STASH_USER" "$STASH_HOME/.vnc/passwd"
  chmod 600 "$STASH_HOME/.vnc/passwd"
  ok "vnc password set"
else
  ok "vnc password already set (delete $STASH_HOME/.vnc/passwd to change it)"
fi

# ── 7. systemd units ────────────────────────────────────────────────────────────────────────

say "systemd units"

cat > /etc/systemd/system/stashling-display.service <<EOF
[Unit]
Description=Stashling X display (TigerVNC) on :${DISPLAY_NUM}
After=network.target
# Explicit crash-loop policy. These belong in [Unit] -- systemd 255 accepts them in [Service]
# with only a journal warning, so the unit loads, looks right, and keeps the 5-starts-in-10s
# defaults that ban it after half a second of looping.
StartLimitIntervalSec=1h
StartLimitBurst=10

[Service]
Type=exec
User=${STASH_USER}
Group=${STASH_USER}
WorkingDirectory=${STASH_HOME}
# -localhost is NOT optional. TigerVNC listens on all interfaces when the SecurityTypes list
# contains a TLS/X509 type without a *None type -- i.e. "hardening" it by adding TLSVnc is
# exactly what publishes port ${VNC_PORT} to your LAN, in front of every session cookie you own.
ExecStart=${XVNC} :${DISPLAY_NUM} \\
  -geometry ${GEOMETRY} -depth 24 \\
  -rfbport ${VNC_PORT} -localhost \\
  -SecurityTypes VncAuth -rfbauth ${STASH_HOME}/.vnc/passwd \\
  -desktop stashling -AlwaysShared -NeverShared=0
Restart=on-failure
RestartSec=5s
SyslogIdentifier=stashling-display

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/stashling-wm.service <<EOF
[Unit]
Description=Stashling window manager (openbox) on :${DISPLAY_NUM}
# Chrome starts fine with no window manager -- Chromium's own test harness merely warns -- but
# window sizing, maximise and fullscreen cannot take effect without one, so the geometry
# silently becomes whatever Chrome picked. Chromium's testing/xvfb.py starts openbox by default
# for this reason.
Requires=stashling-display.service
After=stashling-display.service
BindsTo=stashling-display.service

[Service]
Type=exec
User=${STASH_USER}
Group=${STASH_USER}
Environment=DISPLAY=:${DISPLAY_NUM}
# \$\$ is systemd's documented literal dollar; the shell then sees a plain command substitution.
ExecStartPre=/usr/bin/env sh -c 'for _ in \$\$(seq 1 30); do xdpyinfo >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
ExecStart=/usr/bin/openbox --sm-disable
Restart=on-failure
RestartSec=5s
SyslogIdentifier=stashling-wm

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/libexec/stashling/wait-devtools <<EOF
#!/bin/sh
# Readiness, not merely startedness.
#
# DevToolsActivePort is NOT removed on an unclean exit, so after one crash it sits there
# naming a dead port forever. A probe that only checks the file passes instantly and the
# driver then connects to nothing. The HTTP GET is what decides.
set -eu
PROFILE="\${CHROME_PROFILE:-${STASH_HOME}/chrome-profile}"
DEADLINE=\$(( \$(date +%s) + \${1:-90} ))
while [ "\$(date +%s)" -lt "\$DEADLINE" ]; do
  if [ -s "\$PROFILE/DevToolsActivePort" ]; then
    PORT=\$(head -n1 "\$PROFILE/DevToolsActivePort")
    if curl -fsS --max-time 2 "http://127.0.0.1:\${PORT}/json/version" >/dev/null 2>&1; then
      exit 0
    fi
  fi
  sleep 1
done
echo "stashling: the DevTools endpoint never came up." >&2
echo "  Since Chrome 136 a Google-branded build SILENTLY ignores --remote-debugging-port" >&2
echo "  when --user-data-dir is the default one. Check the unit's ExecStart." >&2
exit 1
EOF
chmod 0755 /usr/local/libexec/stashling/wait-devtools

cat > /etc/systemd/system/stashling-chrome.service <<EOF
[Unit]
Description=Stashling Chrome (long-lived, hand-logged-in profile)
Requires=stashling-display.service
After=stashling-display.service stashling-wm.service network-online.target
Wants=network-online.target
StartLimitIntervalSec=1h
StartLimitBurst=10

[Service]
Type=exec
User=${STASH_USER}
Group=${STASH_USER}
WorkingDirectory=${STASH_HOME}
Environment=DISPLAY=:${DISPLAY_NUM}
Environment=CHROME_PROFILE=${STASH_HOME}/chrome-profile
#
# --user-data-dir is load-bearing twice over: since Chrome 136 remote debugging is silently
#   ignored on the DEFAULT profile, and this is the profile you log into by hand.
# --password-store=basic is pinned FOREVER, deliberately. Chrome picks a cookie-encryption
#   backend at startup; if it picks a keyring on one boot and not the next, the cookies written
#   under the old key become undecryptable and you are logged out of everything with no error
#   message. Pinning removes that whole class of failure. The cost is real and stated plainly
#   in GUIDE.md: `basic` uses a fixed key, so the cookie file is effectively plaintext and the
#   disk is your only protection. Encrypt it.
# There are deliberately NO --disable-backgrounding-* flags here. They are accepted by Chrome
#   and govern process priority, not a tab's visibility state, so they do not fix the
#   inactive-tab problem they are famous for fixing. A flag that is accepted and does nothing is
#   worse than no flag: you stop looking for the real cause.
# There is deliberately NO --load-extension. Chrome 137 removed it from branded builds and
#   Chrome 139 removed --disable-extensions-except. You load the extension by hand, once.
# There is deliberately NO --no-sandbox.
ExecStart=/opt/google/chrome/chrome \\
  --user-data-dir=${STASH_HOME}/chrome-profile \\
  --remote-debugging-port=${DEVTOOLS_PORT} \\
  --password-store=basic \\
  --no-first-run --no-default-browser-check \\
  --window-position=0,0 --window-size=${GEOMETRY/x/,} \\
  --disable-features=Translate \\
  about:blank
ExecStartPost=/usr/local/libexec/stashling/wait-devtools 90
Restart=on-failure
RestartSec=10s
# Shutdown is what protects your logins. KillMode=mixed sends SIGTERM to the BROWSER process
# only, which catches it and runs its session-ending path; the default control-group mode
# SIGTERMs the zygote and every renderer at the same instant, so the browser tries to shut down
# cleanly while its helpers die underneath it. Chrome's cookie store commits on a 30-second
# timer, so a SIGKILL can silently discard up to half a minute of cookie writes and leaves
# profile.exit_type = "Crashed" behind.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=45s
# One bad renderer must not take the unit down with it.
OOMPolicy=continue
OOMScoreAdjust=-500
MemoryHigh=5G
# Hardening that is safe here.
ProtectSystem=full
ProtectHome=yes
ProtectControlGroups=yes
ProtectKernelTunables=yes
ReadWritePaths=${STASH_HOME}
# Hardening that MUST NOT be added. The first two gate the very clone/unshare/setns calls
# Chrome's zygote sandbox makes, and a denied syscall arrives as an uncatchable SIGSYS; the
# third is incompatible with runtime code generation, which is V8.
#   RestrictNamespaces=   SystemCallFilter=   MemoryDenyWriteExecute=   PrivateUsers=
# `systemd-analyze security` will score this unit badly and recommend exactly those. It has no
# concept of a process that builds its own sandbox. Read its output; do not obey it.
SyslogIdentifier=stashling-chrome
LogLevelMax=warning
LogRateLimitIntervalSec=30s
LogRateLimitBurst=2000

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/stashling-collect.service <<EOF
[Unit]
Description=Stashling collection sweep
After=stashling-chrome.service
BindsTo=stashling-chrome.service

[Service]
Type=oneshot
User=${STASH_USER}
Group=${STASH_USER}
Environment=DISPLAY=:${DISPLAY_NUM}
ExecStart=/usr/local/bin/node ${STASH_OPT}/driver/collect.mjs --config ${STASH_ETC}/stashling.json
# For Type=oneshot the RUN time is bounded by TimeoutStartSec, not TimeoutStopSec. Without it a
# hung sweep stays "activating" forever and systemd will not retrigger a unit that is still
# active -- so every later tick is swallowed with no failed unit and no journal error, while
# \`systemctl list-timers\` keeps showing a healthy NEXT.
TimeoutStartSec=20min
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=${STASH_HOME}
SyslogIdentifier=stashling-collect

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/stashling-collect.timer <<'EOF'
[Unit]
Description=Stashling collection, roughly every 30 minutes

[Timer]
OnCalendar=*:00/30
# Catch up a run missed across a reboot. Has NO effect on monotonic timers (OnUnitInactiveSec),
# where it is accepted in silence and does nothing.
Persistent=true
# Real per-firing jitter. AccuracySec= is NOT a substitute: within its window systemd picks a
# "randomized but stable" offset -- the same offset every single firing, forever, which is a
# more legible bot signature than running on the minute. The capture randomises its own scroll
# intervals for the same reason; this is that argument one level up.
RandomizedDelaySec=420
FixedRandomDelay=false
AccuracySec=1s
Unit=stashling-collect.service

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/stashling-export.service <<EOF
[Unit]
Description=Stashling nightly export (the whole point of the project)
After=stashling-chrome.service
BindsTo=stashling-chrome.service

[Service]
Type=oneshot
User=${STASH_USER}
Group=${STASH_USER}
ExecStart=/usr/bin/env sh -c '/usr/local/bin/node ${STASH_OPT}/driver/collect.mjs --config ${STASH_ETC}/stashling.json --export ${STASH_HOME}/exports/stashling-\$\$(date +%%Y-%%m-%%d).jsonl'
TimeoutStartSec=15min
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=${STASH_HOME}
SyslogIdentifier=stashling-export

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/stashling-export.timer <<'EOF'
[Unit]
Description=Stashling nightly export

[Timer]
OnCalendar=*-*-* 04:17:00
Persistent=true
RandomizedDelaySec=900
FixedRandomDelay=false
Unit=stashling-export.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
ok "units written"

for u in stashling-chrome.service stashling-display.service stashling-collect.service; do
  systemd-analyze verify "/etc/systemd/system/$u" 2>&1 | grep -v '^$' || true
done
ok "units verified"

# ── 8. config ───────────────────────────────────────────────────────────────────────────────

say "config"

if [[ ! -f "$STASH_ETC/stashling.json" ]]; then
  cp "$HERE/stashling.example.json" "$STASH_ETC/stashling.json"
  sed -i "s#__PROFILE__#${STASH_HOME}/chrome-profile#; s#__STATE__#${STASH_HOME}/state#; s#__EXTENSION__#${STASH_OPT}/extension#" \
    "$STASH_ETC/stashling.json"
  chmod 0644 "$STASH_ETC/stashling.json"
  note "wrote $STASH_ETC/stashling.json from the example -- EDIT IT before enabling the timer."
  note "Every target needs a minRows you can only know after one successful run by hand."
else
  ok "$STASH_ETC/stashling.json already exists, left alone"
fi

# ── 9. start the long-lived half ────────────────────────────────────────────────────────────

say "starting"

systemctl enable --now stashling-display.service stashling-wm.service >/dev/null
systemctl enable --now stashling-chrome.service >/dev/null
sleep 2
systemctl is-active --quiet stashling-chrome.service \
  && ok "chrome is up on :${DISPLAY_NUM}, devtools on 127.0.0.1:${DEVTOOLS_PORT}" \
  || die "chrome did not start. journalctl -u stashling-chrome -n 50"

# The timers are deliberately NOT enabled. They would fire against a browser that is not logged
# in to anything and an extension that is not loaded, and produce a string of red units and a
# collection full of login pages.
note "the collect/export timers are NOT enabled yet -- finish the by-hand steps first."

cat <<EOF

$(printf '\033[1;32m')Built.$(printf '\033[0m') Three things remain, and only a human can do them.

  1. Open the display from your Windows PC:

         ssh -N -L ${VNC_PORT}:127.0.0.1:${VNC_PORT} $(logname 2>/dev/null || echo you)@$(hostname -f 2>/dev/null || hostname)

     then point a VNC viewer at  localhost:${DISPLAY_NUM}

  2. In that Chrome window:
       a. chrome://extensions -> turn on Developer mode -> "Load unpacked" -> ${STASH_OPT}/extension
          Leave Developer mode ON. Since Chrome 134 an unpacked extension is enabled only
          while that switch is on, and turning it off disables the collector silently.
       b. Log in to YouTube / MakerWorld / Kleinanzeigen. By hand. In THIS window.
       c. Open each list page, click the Stashling button, and GRANT the host permission.
          A timer can never do this: permissions.request() needs a real user gesture.

  3. Then, back over SSH:

         sudo ${HERE}/doctor.sh          # checks all of the above, loudly
         sudo -u ${STASH_USER} /usr/local/bin/node ${STASH_OPT}/driver/collect.mjs \\
              --config ${STASH_ETC}/stashling.json

     Put the row count that run reports into minRows in ${STASH_ETC}/stashling.json
     (a little under it), then:

         sudo systemctl enable --now stashling-collect.timer stashling-export.timer

The full walkthrough, including what each check means when it fails, is in
hosts/edge-linux/GUIDE.md.

EOF
