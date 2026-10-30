# Edge collector on Linux — the guide

An always-on box that keeps your lists collected while you are not looking: one Chrome, logged
in **by hand**, driven on a timer. This is the operating model ADR-0007 settles on — the edge is
the only acquirer, and it is a complete product on its own.

```
Xtigervnc :1 (virtual screen, no monitor needed)
  ├── openbox                 so window geometry actually applies
  └── Google Chrome           one profile, logged in by you, over VNC
        └── DevTools 127.0.0.1 ── driver/collect.mjs ── stashling-collect.timer (every ~30 min)
```

> **Status — read before you rely on it.** The driver's decisions are unit-tested (`node --test`)
> and the shell scripts are linted in CI. **The whole stack has not yet been run end to end on
> real hardware.** Your first install is that test. Run `doctor.sh` after every step below and
> believe it over this document.

---

## 1. The machine

Written with a **Lenovo ThinkCentre M720q Tiny** in mind; anything x86-64 that runs Ubuntu
Server 24.04 LTS behaves the same.

- **Architecture.** The M720q is x86-64, so `amd64` Google Chrome. No GPU is involved: Xtigervnc
  is a virtual framebuffer, so the box needs no monitor attached.
- **Memory.** The Chrome unit sets `MemoryHigh=5G`. Fine on 8 GB and above. On a 4 GB machine
  lower it in `bootstrap.sh` before installing, or the browser will be throttled constantly.
- **Power.** In the firmware setup, set the behaviour *after power loss* to **power on**. An
  always-on collector that stays off after a power cut is the quietest failure there is. (On
  ThinkCentre models this lives under *Power*; check the exact wording on yours.)
- **Network.** Wired is better. The Chrome unit waits for `network-online.target`.
- **Disk encryption — decide before you install.** See §5. It is the one choice that is
  expensive to change later.

Install Ubuntu Server 24.04 LTS **without** a desktop. `bootstrap.sh` installs only the minimal
X stack it needs.

## 2. Install

On the box, as your normal admin user:

```bash
sudo apt-get install -y git
git clone https://github.com/krausstt/stashling.git
cd stashling
sudo ./hosts/edge-linux/bootstrap.sh
```

**Clone with git; do not copy the folder over a Windows share or OneDrive.** Those deliver CRLF
line endings, and bash reports that as `bad interpreter: /usr/bin/env bash^M` — an error about
the shebang, not the line endings, which sends you looking in the wrong place.

The script is idempotent and never touches the Chrome profile, so running it again cannot log
you out. It asks once for a VNC password (§4 says what that password is worth).

What it does: installs Chrome (held, see §6), Node from the official checksummed tarball (Ubuntu's
own `nodejs` is Node 18 and cannot speak CDP), creates the `stashling` system user with its home
under `/var/lib` (which is what lets the unit use `ProtectHome=yes`), installs the extension and
driver read-only under `/opt/stashling`, writes Chrome policy and the systemd units, and starts the
display and Chrome. **It does not enable the timers** — they would fire against a browser that is
logged in to nothing.

## 3. The things only a human can do

These cannot be automated, and the reasons are permanent rather than temporary.

**Open the screen from your PC.** VNC listens on localhost only, so tunnel to it:

```bash
ssh -N -L 5901:127.0.0.1:5901 you@the-box
```

then point any VNC viewer at `localhost:1`.

**In that Chrome window:**

1. `chrome://extensions` → **Developer mode on** → **Load unpacked** → `/opt/stashling/extension`.
   *Leave Developer mode on.* An unpacked extension is enabled only while that switch is on;
   turning it off — or dismissing the "disable developer mode extensions" bubble — disables the
   collector silently. Branded Chrome no longer accepts `--load-extension`, so there is no
   scripted alternative.
2. **Log in** to YouTube, MakerWorld, and anything else you collect from. By hand, in this
   window. The design depends on these being your real sessions: a server cannot hold them, and
   bot protection that fingerprints browser and TLS is exactly what this avoids.
3. **Open each list page, click the Stashling button, and grant the host permission.** This is
   *the one thing a human must do* that people expect to script. `chrome.permissions.request()`
   resolves only inside a real user gesture, and DevTools cannot supply one — its
   `userGesture: true` flag confers no activation at all. So the grant is yours to give, once per
   site.

## 4. First run, `minRows`, then the timer

```bash
sudo ./hosts/edge-linux/doctor.sh
sudo -u stashling /usr/local/bin/node /opt/stashling/driver/collect.mjs \
     --config /etc/stashling/stashling.json
```

The sweep prints, per target, how many rows it saw. Put a number a little **under** that into
`minRows` for each target in `/etc/stashling/stashling.json`.

`minRows` is the most important setting here and the only one you cannot guess. The
characteristic failure of this whole design is silent: if the collection tab is not the visible,
active tab, a virtualised list renders only its first screenful, the row count stops growing,
and the capture reports `settled: true` having collected a fraction of your list. Nothing errors.
`minRows` is the floor below which that is treated as truncated instead of merged. The example
ships `minRows: 1`, which asserts nothing — `doctor.sh` warns until you change it. Re-check it as
your lists grow.

Then:

```bash
sudo systemctl enable --now stashling-collect.timer stashling-export.timer
```

Collection runs roughly every 30 minutes with real per-firing jitter, and an export lands in
`/var/lib/stashling/exports/` every night. **The export is the point of the project** — it is the
copy you own.

**About the VNC password:** VncAuth uses only the **first 8 characters**, is not rate-limited, and
is an obfuscated shared secret rather than real authentication. It is a speed bump in front of the
SSH tunnel, not a lock, which is why the server binds to localhost. Never add a TLS security type
to "harden" it: with TigerVNC that is what makes it listen on every interface.

## 5. What this box protects, and what protects it

The Chrome profile in `/var/lib/stashling/chrome-profile` is a **credential store**: live cookies
for every platform you logged into.

**The cookies are effectively stored in plain text.** The unit pins `--password-store=basic`, on
purpose and forever: Chrome picks a cookie-encryption backend at startup, and if it picks a keyring
on one boot and not the next, every cookie written under the old key becomes undecryptable and you
are logged out of everything with no error — weeks later, after a reboot. Pinning removes that
whole class of failure. The cost is that `basic` uses a fixed key, so **the disk is the only
protection** the cookies have.

So encrypt the disk, and choose how it unlocks:

| Option | Unattended reboot? | Protects against |
|---|---|---|
| LUKS with a passphrase | **No** — someone types it at every boot | a stolen box, powered off |
| LUKS unlocked by the TPM (`systemd-cryptenroll --tpm2-device=auto`) | yes | a stolen *disk*; much less so a stolen box |
| No encryption | yes | nothing |

For an always-on collector, TPM unlock is usually the honest middle. Ubuntu 24.04's systemd
supports it; verify the steps against your install rather than trusting a summary here.

**The DevTools port has no authentication at all.** It is bound to loopback, but loopback is not
access control: any process on the box running as any user can attach to it and read every
cookie. The same holds for the X display. Keep this box single-purpose, with no other users and
no untrusted software.

## 6. Upgrading Chrome

Chrome is **held** (`apt-mark hold`) and excluded from unattended upgrades, deliberately. An
unattended upgrade replaces the binary under a running browser that nothing restarts; later a newly
spawned child runs the *new* binary against the *old* browser, and whatever breaks looks like a
site change. But never upgrading is worse: Chrome is the internet-facing part of a machine holding
your sessions.

So upgrade on purpose, often:

```bash
sudo ./hosts/edge-linux/upgrade-chrome.sh             # upgrade, restart cleanly, run one real sweep
sudo ./hosts/edge-linux/upgrade-chrome.sh --rollback  # if that sweep failed
```

It caches the outgoing `.deb` before upgrading, because the apt index only ever advertises one
version. If the cache is gone, old versions are still in Google's pool:

```
https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_<VERSION>_amd64.deb
```

A sweep that fails after an upgrade is a useful signal: a new major version changing rendered
markup is exactly what connector maintainers need to hear about.

## 7. When something is wrong

Every check in `doctor.sh` exists because the thing it checks fails **silently** — the box's whole
failure mode is looking healthy. The common ones:

| Symptom | Likely cause |
|---|---|
| `truncated: saw N rows, expected at least M` | the tab was not the active, visible tab, or the session is half logged out |
| `needs-human: redirected to …accounts.google…` | the session lapsed — log in again over VNC |
| `needs-human: host permission not granted` | §3, step 3 |
| `the Stashling extension is not loaded as …` | Developer mode was switched off, or the extension was loaded from another path — or set `extensionId` in the config to the id `chrome://extensions` shows |
| no DevTools endpoint | Chrome is down, or was started with the default profile, where branded Chrome silently ignores `--remote-debugging-port` |
| last sweep more than 48 h old, unit green | look at `journalctl -u stashling-collect`; the driver now reclaims a lock left by a killed sweep, so a recurring warning means a sweep keeps hanging |

Logs: `journalctl -u stashling-chrome`, `-u stashling-collect`, `-u stashling-export`. The last
sweep's full result is in `/var/lib/stashling/state/last-run.json`.

## 8. What it deliberately never does

It never logs in anywhere, never solves a CAPTCHA (a challenge stops the run and asks for you),
never passes `--no-sandbox`, and never adds the systemd hardening options that break Chrome's own
sandbox (`RestrictNamespaces=`, `SystemCallFilter=`, `MemoryDenyWriteExecute=`, `PrivateUsers=`).
`systemd-analyze security` will recommend exactly those; it has no concept of a process that
builds its own sandbox.
