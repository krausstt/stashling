# 0005 — Host permissions are optional and requested at activation

**Status:** accepted, 2026-09-03

## Context

The default shape for a multi-site extension is a static `host_permissions` list covering every
supported site. At install, the user is asked for access to all of them at once.

For a platform whose connector count is meant to grow, that is wrong on three axes:

1. **It is a review finding.** Chrome Web Store policy requires an extension to *"request access
   to the narrowest permissions necessary"*; excessive permissions are their own violation class
   and are additionally read as evidence of *unrelated functionality*, which loops straight back
   into a single-purpose flag.
2. **It is untrue to the design.** An unused connector would hold live access to a site the user
   never asked it to touch.
3. **It gets worse with every connector.** The install prompt is the growth-limiting factor on a
   design whose whole premise is that adding sources is cheap.

## Decision

Ship near-zero static host permissions. Declare every connector's hosts in
**`optional_host_permissions`** and request them via `chrome.permissions.request()` at the moment
the user first collects from that site — from inside a user gesture, because nothing else works.

`scripts/check-extension.mjs` fails the build if a static `host_permissions` entry appears.

## The failure mode this must make visible

**A newly declared optional host permission is not granted by reloading or updating the
extension.** It is granted only by an explicit request from a user gesture.

MakerWorld's scraper hit exactly this: a host permission added in 0.6.0 was not auto-granted on
reload, thumbnail fetching failed silently for an entire release — zero thumbnails, no error —
and the mitigation was a hard-coded hint string printed after the fact, once someone worked out
what had happened.

So the popup checks `permissions.contains()` before every run and renders the ungranted state as
a first-class screen with a button, rather than discovering it mid-scrape.

## Consequences

- One extra click the first time a user collects from a site. That click is also the honest
  moment to say what will be read, which the store's Limited Use policy now requires be
  disclosed in the product UI and not only on the listing page.
- The connector count becomes a **privacy property you can advertise** instead of a liability:
  "it can reach exactly the sites you have collected from, and you can revoke any of them".
- Firefox 128+ supports `optional_host_permissions` with comparable semantics, so the same
  manifest works there.
- `declarativeNetRequest` **cannot** be optional, per Chrome's documentation. If this project
  ever needs it, that is a separate decision with a different permission story.
- After a `permissions.remove()`, a later `request()` usually re-adds the permission without
  prompting. Revocation in the UI is therefore genuine but not adversarial, and should not be
  described as if it were a security boundary against the extension itself.
