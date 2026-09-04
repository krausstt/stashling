/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `dom-active-tab` — read the rendered DOM of the logged-in tab, auto-scrolling a virtualized
 * list until the row count stops growing.
 *
 * The host implements this once. A connector only DECLARES that it needs it, along with the
 * element to scope to and the scroll budget — it never calls `chrome.scripting` itself. That is
 * what lets the same connector run here, in the Node CLI against a saved file, and in a test
 * against a fixture, with no branching.
 *
 * WHY THE RENDERED DOM AND NOT AN EMBEDDED JSON BLOB: measured on a real 12.7 MB Watch Later
 * capture, `ytInitialData` contained ZERO playlist rows and 39 videoIds belonging to an entirely
 * different route, left behind by SPA navigation. The rendered DOM is the only source of truth
 * for what is actually on the page; embedded JSON is an optimization a connector may opt into.
 *
 * WHY autoScroll EXISTS AT ALL: a virtualized list only materialises the rows near the
 * viewport. The 582 rows in that capture were 582 because that is how far the page had been
 * scrolled — not because the playlist is 582 long. Neither of the two shipped scrapers this is
 * distilled from handles that: one instructs the user to scroll manually, the other's notes say
 * infinite scroll is simply not handled.
 *
 * AND WHY IT REPORTS RATHER THAN PROMISES: autoScroll is a mitigation, not a guarantee. The
 * result carries `rowsSeen`, `settled` and `stoppedBecause`, and the UI shows them. Silently
 * under-collecting is the single worst failure available to a tool whose promise is that you
 * keep everything.
 */

if (!globalThis.browser) globalThis.browser = chrome

/**
 * Injected into the page. Must be entirely self-contained — it is serialised across the
 * process boundary, so it closes over nothing and receives everything as arguments.
 */
function scrollAndSerialize(scope, maxMs, settleMs, stableRounds, stepMin, stepMax) {
  return new Promise((resolve) => {
    const countRows = () => {
      if (!scope) return 0
      // Count OPEN TAGS via the live DOM rather than a substring of the HTML: on the measured
      // page the bare element name appears 12,804 times as a CSS scope token and only 582 times
      // as an element.
      try {
        return document.getElementsByTagName(scope).length
          || document.querySelectorAll(scope).length
      } catch {
        return document.getElementsByTagName(scope).length
      }
    }

    const started = Date.now()
    let last = countRows()
    let stable = 0
    let stoppedBecause = 'settled'

    const finish = () => {
      resolve({
        html: document.documentElement.outerHTML,
        url: location.href,
        title: document.title,
        rowsSeen: countRows(),
        settled: stoppedBecause === 'settled',
        stoppedBecause,
        scrolledMs: Date.now() - started,
      })
    }

    if (!scope || !maxMs) {
      stoppedBecause = 'no-autoscroll'
      finish()
      return
    }

    const step = () => {
      if (Date.now() - started > maxMs) {
        // A deadline, not a failure: a pathological page must not scroll forever. The caller is
        // told the budget ran out so it can say the capture may be partial.
        stoppedBecause = 'deadline'
        finish()
        return
      }

      window.scrollTo(0, document.documentElement.scrollHeight)

      // Randomised, not fixed. A metronome is the most legible bot signature there is, and this
      // runs inside the user's own logged-in session.
      const wait = settleMs + Math.floor(Math.random() * Math.max(1, stepMax - stepMin)) + stepMin

      setTimeout(() => {
        const now = countRows()
        if (now > last) {
          last = now
          stable = 0
        } else {
          stable += 1
          if (stable >= stableRounds) {
            stoppedBecause = 'settled'
            finish()
            return
          }
        }
        step()
      }, wait)
    }

    step()
  })
}

/**
 * @param {object} connector
 * @param {number} tabId
 * @param {object} [opts] `{ onProgress }`
 * @returns {Promise<{html:string, url:string, rowsSeen:number, settled:boolean,
 *                    stoppedBecause:string, scrolledMs:number}>}
 */
export async function capture(connector, tabId, opts = {}) {
  const acq = connector.acquisition ?? {}
  const scroll = acq.autoScroll ?? null
  const [minMs, maxStep] = acq.throttleMs ?? [400, 1200]

  opts.onProgress?.({ phase: 'scanning', note: scroll ? 'scrolling until the row count settles' : 'reading the page' })

  const [result] = await browser.scripting.executeScript({
    target: { tabId },
    // MAIN vs ISOLATED: ISOLATED is correct here. The page's own JS is irrelevant — we read
    // rendered DOM — and running in MAIN would expose this code to the page.
    world: 'ISOLATED',
    func: scrollAndSerialize,
    args: [
      acq.scope ?? null,
      scroll ? Number(scroll.maxMs) || 0 : 0,
      scroll ? Number(scroll.settleMs) || 1000 : 0,
      scroll ? Number(scroll.stableRounds) || 3 : 0,
      minMs,
      maxStep,
    ],
  })

  if (!result?.result) throw new Error('the page returned nothing — is it still open and loaded?')
  return result.result
}
