// ==UserScript==
// @name         Claude Sheets Broker Sync
// @namespace    http://tampermonkey.net/
// @version      3.9
// @description  One script for every broker site: Vanguard cost basis, Schwab cost basis, Vanguard / Merrill / Betterment balance readings, all to the claude-sheets Cloud Functions with ONE API key. Passive: never navigates or clicks on its own - only a menu command you chose does (v3.5: Schwab "Sync positions"; v3.6: opt-in auto-login after a password-manager fill).
// @author       Tom
// @homepageURL  https://github.com/tbarthen/userscripts
// @updateURL    https://raw.githubusercontent.com/tbarthen/userscripts/main/claude-sheets-broker-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/tbarthen/userscripts/main/claude-sheets-broker-sync.user.js
// @match        https://*.vanguard.com/*
// @match        https://vanguard.com/*
// @match        https://client.schwab.com/*
// @match        https://www.benefits.ml.com/*
// @match        https://wwws.betterment.com/*
// @match        https://app.betterment.com/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      personal1.vanguard.com
// @connect      us-central1-claude-sheets.cloudfunctions.net
// ==/UserScript==

/*
 * v3.0 (2026-09-03) — the merge of vanguard-costbasis 2.0, schwab-costbasis 2.0 and
 * broker-readings 1.0 into ONE script, at Tom's request: one install, one key entry
 * (Tampermonkey storage is per-script), one file to update. Each site has a HANDLER
 * below; only the handler for the site you are on runs, and only its menu commands
 * are registered, so the Tampermonkey menu stays short.
 *
 *   Vanguard    cost-basis.web.vanguard.com exports the unrealized lots (Vanguard's own
 *               cost-basis API, read with your session) → vanguardCostBasisProxy.
 *               Anywhere else on vanguard.com (v3.1: the "upgraded" site lives at
 *               vanguard.com/en/investor/..., not *.web.vanguard.com): menu "Export
 *               cost basis now". Needs the account ID (menu "Set Vanguard account ID").
 *               login.vanguard.com is excluded on purpose. @noframes (v3.2): the site
 *               embeds survey iframes on vanguard.com that matched too, so every menu
 *               command registered once per frame and the prompt came from the iframe.
 *   Schwab      client.schwab.com Positions with All Brokerage Accounts selected: the
 *               page's own HoldingV2 response is read passively → schwabCostBasisProxy.
 *               Menu: "Sync positions" (v3.5: from ANY Schwab page - goes to Positions
 *               first if needed, then selects All Brokerage Accounts; the selection
 *               makes the page fetch holdings, which the intercept syncs), "Reset sync".
 *               The hand-off across the page load is a GM flag with a 2-minute life, so
 *               a plain visit to Positions never clicks anything (the v1.1 hijack).
 *               v3.5 also posts the ACCOUNT LIST the response spoke for (an emptied
 *               account gets its rows closed) and sends "Incomplete"-basis positions
 *               with a null basis (held, so not closed) - hardening audit 188, A1/A2.
 *   Merrill     benefits.ml.com/Accounts/Home: total market value + the footnote's
 *               "previous business day M/D/YYYY" (the PRIOR close) → brokerReadingsProxy.
 *   Betterment  betterment.com/app/performance: the "Balance" figure + "As of MM/DD/YYYY"
 *               → brokerReadingsProxy. v3.3: the app is a single-page app — you land on
 *               /app and click Performance without a page load, and Tampermonkey injects
 *               only on a load — so the script matches all of /app* and WATCHES the URL,
 *               running the reader each time you arrive on the Performance page.
 *
 * NOTHING NAVIGATES. The v1.x scripts redirected pages and clicked selectors, which made
 * the sites unusable with them enabled; every action here happens on the page you chose
 * to open, or from the menu.
 *
 * v3.6–3.9 (2026-09-17) — AUTO-LOGIN, OPT-IN (menu "Auto-login after autofill", off until you
 * turn it on). The broker-sync launcher (AutoHotKey `broker_sync.ahk`, Ctrl+Alt+B or the
 * on-unlock scheduled task) opens the three data pages; a site whose session expired shows
 * its login page instead, and Bitwarden fills it (page load, or Ctrl+Shift+L sent by the
 * launcher for Vanguard's late-rendered form). This script then clicks Log in — and only
 * then: it acts when a password field is visible AND both fields are populated AND no key
 * printable key was pressed in the tab (a human typing is never submitted for; the launcher's
 * Ctrl+Shift+L chord is not typing — v3.7), AND the button is enabled and any bot check
 * on the page has written its response field (Betterment's "Security check" — v3.8/3.9), AND this site has not
 * been submitted in the last 10 minutes (ONE attempt per site per run — a retried wrong
 * password is how accounts get locked). It never reads, stores or types a credential.
 *   Merrill's password input carries an Inputmask (`data-sparta-input-mask`,
 *   inputEventOnly) that discards programmatic values, so on that page the input is
 *   replaced by a plain clone before the fill; if Merrill's submit rejects the clone, the
 *   fallback is typing the password by hand (the site remembers the user ID and device).
 * The tab title is prefixed on completion — "✅ " once a reading was posted (or was already
 * on the sheet), "⚠️ " when nothing could be read — so a glance at the tab strip is the
 * run report; an open login page is a tab that needs you.
 *
 * NO SECRETS IN THIS FILE. The one API key (`cloud-functions-api-key`; all three functions
 * take it since 2026-09-03) and the Vanguard account ID live in Tampermonkey storage, set
 * once from the menu. This file is public (github.com/tbarthen/userscripts).
 * Page anchors: docs/portfolio/broker_readings_scrape_notes.md in the workbook repo.
 */
(function () {
    'use strict';

    const FUNCTIONS = 'https://us-central1-claude-sheets.cloudfunctions.net';
    const MONEY = /^\$[\d,]+\.\d{2}$/;
    const TOAST_ID = 'claude-sheets-toast';

    // ============ SETTINGS (Tampermonkey storage, never in this file) ============
    function setting(name) { return (GM_getValue(name, '') || '').trim(); }
    function askAndStore(name, label) {
        const value = window.prompt(`${label}${setting(name) ? ' (currently set; blank keeps it)' : ''}:`, '');
        if (value && value.trim()) { GM_setValue(name, value.trim()); toast(`${label} saved`); }
    }
    function requireKey() {
        const apiKey = setting('apiKey');
        if (!apiKey) toast('Not configured: set the API key from the Tampermonkey menu', true);
        return apiKey;
    }

    // ============ UI ============
    function toast(message, isError = false, ms = 6000) {
        document.getElementById(TOAST_ID)?.remove();
        const el = document.createElement('div');
        el.id = TOAST_ID;
        el.textContent = message;
        el.style.cssText = `position:fixed;top:20px;right:20px;padding:14px 20px;` +
            `background:${isError ? '#d32f2f' : '#1a73e8'};color:white;border-radius:8px;` +
            `font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;z-index:2147483647;` +
            `box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:440px;`;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), ms);
        console.log(`[Claude Sheets] ${message}`);
    }

    /** v3.6: the tab title is the run report for the launcher's tab strip. */
    function markTab(ok) {
        const bare = document.title.replace(/^(✅|⚠️)\s*/, '');
        document.title = `${ok ? '✅' : '⚠️'} ${bare}`;
    }

    // ============ HANDLER: auto-login after a password-manager fill (v3.6, opt-in) ============
    const login = {
        ATTEMPT_WINDOW_MS: 10 * 60 * 1000, POLL_MS: 300, POLL_LIMIT_MS: 90000,
        visible: (el) => !!(el && el.offsetParent !== null && !el.disabled && !el.readOnly),
        passwordField: () => [...document.querySelectorAll('input[type="password"]')].find(login.visible) || null,
        // The text field that precedes the password field in DOM order (username / email);
        // Merrill remembers the user ID in a dropdown, so "none" is a valid answer.
        userField(pw) {
            const inputs = [...document.querySelectorAll('input')];
            const before = inputs.slice(0, inputs.indexOf(pw)).reverse();
            return before.find(i => login.visible(i) && /^(text|email)$/i.test(i.type || 'text')) || null;
        },
        // A DISABLED button still counts as found (a site disables it until its bot check
        // clears — v3.8); readiness is judged separately by login.ready().
        shown: (el) => !!(el && el.offsetParent !== null),
        submitButton(pw) {
            const form = pw.form || pw.closest('form') || document;
            const explicit = form.querySelector('button[type="submit"], input[type="submit"]');
            if (explicit && login.shown(explicit)) return explicit;
            return [...form.querySelectorAll('button, input[type="button"], a[role="button"]')]
                .find(b => login.shown(b) && /^\s*(log|sign)\s*in\s*$/i.test(b.textContent || b.value || '')) || null;
        },
        // v3.8: the form is READY to submit only when its button is enabled and any bot check on
        // the page has cleared. Betterment shows a "Security check" block that resolves to
        // "Success!" on its own after a few seconds; a click before that is swallowed, and the
        // one-attempt latch then (correctly) refuses a second one — so the click must wait.
        // v3.9: the widget's own "Success!" text lives inside its iframe, invisible to this
        // script — so readiness is read from the hidden RESPONSE field every such widget writes
        // when solved (hCaptcha / Turnstile / reCAPTCHA). No widget on the page → ready.
        CAPTCHA_RESPONSE: 'textarea[name="h-captcha-response"], input[name="h-captcha-response"], input[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"]',
        ready(button) {
            if (button.disabled || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('aria-busy') === 'true') return false;
            const responses = [...document.querySelectorAll(login.CAPTCHA_RESPONSE)];
            if (responses.length && !responses.some(r => (r.value || '').length > 0)) return false;
            return true;
        },
        // Merrill: replace the Inputmask-bound password input with a plain clone (same id/name,
        // no listeners, no autocomplete=off) so a programmatic fill sticks.
        stripMask(pw) {
            if (!pw.hasAttribute('data-sparta-input-mask')) return pw;
            const clone = pw.cloneNode(false);
            clone.removeAttribute('data-sparta-input-mask');
            clone.removeAttribute('autocomplete');
            pw.replaceWith(clone);
            toast('Merrill: password input mask removed for the fill', false, 3000);
            return clone;
        },
        test: () => setting('autoLogin') === 'on',
        menu: [],
        // The login form may render after load (Vanguard) or the tab may not be a login page
        // at all (session still trusted): watch for a visible password field, act once it is
        // there, give up quietly after POLL_LIMIT_MS.
        start() {
            const host = location.hostname;
            let typed = false, seen = false, done = false;
            // A human TYPING: a printable key, Backspace or Delete with no Ctrl/Alt/Meta. A modifier
            // chord is not typing — the launcher sends Bitwarden's own Ctrl+Shift+L to fill late-
            // rendered (Vanguard) or re-created (Merrill) forms, and must not cancel this handler.
            document.addEventListener('keydown', (e) => {
                if (e.ctrlKey || e.altKey || e.metaKey) return;
                if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') typed = true;
            }, true);
            const began = Date.now();
            // `done` is the latch: once this handler has decided (clicked, blocked, handed over
            // to a human, or timed out) it never acts again on this page, whatever the timer does.
            const finish = () => { done = true; clearInterval(timer); };
            const timer = setInterval(() => {
                if (done) return;
                if (typed) { finish(); return; }                            // a human is doing it
                let pw = login.passwordField();
                if (!pw) {
                    if (seen || Date.now() - began > login.POLL_LIMIT_MS) finish();   // logged in, or never a login page
                    return;
                }
                if (!seen) {
                    seen = true;
                    const last = Number(GM_getValue(`loginAttempt:${host}`, 0) || 0);
                    if (Date.now() - last < login.ATTEMPT_WINDOW_MS) {
                        finish();
                        toast(`${host}: a login was already submitted ${Math.round((Date.now() - last) / 1000)}s ago — not retrying (one attempt per run). Sign in by hand if needed.`, true, 10000);
                        return;
                    }
                    pw = login.stripMask(pw);
                }
                const user = login.userField(pw);
                const filled = pw.value.length > 0 && (!user || user.value.length > 0);
                if (filled) {
                    const button = login.submitButton(pw);
                    if (!button) { finish(); toast(`${host}: filled, but no Log in button found — press it yourself`, true, 8000); return; }
                    if (!login.ready(button)) {                                // bot check / disabled: keep waiting
                        if (Date.now() - began > login.POLL_LIMIT_MS) { finish(); toast(`${host}: filled, but the form never became ready — press Log in yourself`, true, 8000); }
                        return;
                    }
                    finish();
                    GM_setValue(`loginAttempt:${host}`, Date.now());
                    toast(`${host}: password manager filled the form — logging in (one attempt)`, false, 4000);
                    button.click();
                    return;
                }
                if (Date.now() - began > login.POLL_LIMIT_MS) finish();     // nothing filled: yours
            }, login.POLL_MS);
        }
    };

    /** POST JSON to one of the Cloud Functions with the shared key; resolves the parsed body. */
    function postToFunction(name, payload, apiKey) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${FUNCTIONS}/${name}`,
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
                data: JSON.stringify(payload),
                onload(response) {
                    let result = null;
                    try { result = JSON.parse(response.responseText); } catch {}
                    if (response.status === 200 && result && result.success) resolve(result);
                    else reject(new Error(`${name} ${response.status}${result && result.error ? ': ' + result.error : ''}`));
                },
                onerror() { reject(new Error(`network error calling ${name}`)); }
            });
        });
    }

    // ============ HANDLER: Vanguard cost basis ============
    const vanguard = {
        test: () => /(^|\.)vanguard\.com$/.test(location.hostname) && location.hostname !== 'login.vanguard.com',
        menu: [['Export cost basis now', () => vanguard.run()],
               ['Set Vanguard account ID', () => askAndStore('vanguardAccountId', 'Vanguard account ID')],
               // v3.4: the dashboard's balance, as of the date Vanguard itself states.
               ['Read balance now', () => readings.run(true)],
               ['Set Vanguard balance account (last digits)', () => askAndStore('vanguardBalanceAccount', 'Vanguard balance account (last digits of the account number)')]],
        start() {
            if (location.hostname === 'cost-basis.web.vanguard.com') setTimeout(() => vanguard.run(), 2000);
            // v3.4: the dashboard is a single-page app too — watch the URL, read when it
            // lands on the dashboard (READERS.vanguard). Nothing else on vanguard.com is read.
            readings.start();
        },
        async run() {
            const apiKey = requireKey(); if (!apiKey) return;
            const accountId = setting('vanguardAccountId');
            if (!accountId) { toast('Not configured: set the Vanguard account ID from the Tampermonkey menu', true); return; }
            toast('Vanguard: fetching cost basis...');
            try {
                const data = await vanguard.fetchLots(accountId);
                const lots = (data.coveredLots?.length || 0) + (data.nonCoveredLots?.length || 0);
                toast(`Vanguard: sending ${lots} lots...`);
                const result = await postToFunction('vanguardCostBasisProxy', data, apiKey);
                toast(`Vanguard: done — ${result.inserted} new, ${result.updated} updated`);
            } catch (error) { toast(`Vanguard: ${error.message}`, true, 10000); }
        },
        fetchLots(accountId) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://personal1.vanguard.com/smn-client-cost-basis-accounting-webservice/costbasis/external/lots?request=unrealized',
                    headers: { 'accept': 'application/json', 'consumer-application-code': 'HDV',
                               'x-account-id': accountId, 'x-holding-id': '0' },
                    onload(response) {
                        if (response.status === 200) {
                            try { const data = JSON.parse(response.responseText); data.accountId = accountId; resolve(data); }
                            catch { reject(new Error('failed to parse the Vanguard response')); }
                        } else if (response.status === 401) reject(new Error('session expired - log in again'));
                        else reject(new Error(`Vanguard API returned ${response.status}`));
                    },
                    onerror() { reject(new Error('network error calling the Vanguard API')); }
                });
            });
        }
    };

    // ============ HANDLER: Schwab cost basis (passive XHR intercept) ============
    const SCHWAB_SECURITY_TYPES = { 1: 'Equity', 2: 'ETF', 3: 'MutualFund', 9: 'Cash' };
    const SCHWAB_POSITIONS_URL = 'https://client.schwab.com/app/accounts/positions/#/';
    const SCHWAB_PENDING_KEY = 'schwab.pendingSelectAll';     // GM flag: set by the menu, read once on the Positions load
    const SCHWAB_PENDING_TTL_MS = 2 * 60 * 1000;
    const schwab = {
        test: () => location.hostname === 'client.schwab.com',
        onPositions: () => /^\/app\/accounts\/positions\b/.test(location.pathname || ''),
        synced: false,
        menu: [['Sync positions (go to Positions, select All Brokerage Accounts)', () => schwab.syncFromAnywhere()],
               ['Reset sync (allow re-sync)', () => { schwab.synced = false; toast('Schwab: sync reset - reload Positions to sync again'); }]],
        start() {
            schwab.resumePendingSelect();
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this._url = url;
                return originalOpen.apply(this, [method, url, ...rest]);
            };
            XMLHttpRequest.prototype.send = function (body) {
                if (this._url && this._url.includes('/Holdings/HoldingV2')) {
                    this.addEventListener('load', function () {
                        try {
                            const data = JSON.parse(this.responseText);
                            if (data.accounts && data.accounts.length > 1) {          // All Brokerage Accounts selected
                                const positions = schwab.extractPositions(data);
                                const accounts = schwab.extractAccounts(data);
                                // v3.5: an account list with zero positions is a liquidation, and is sent.
                                if (positions.length || accounts.length) schwab.sync(positions, accounts);
                            } else {
                                console.log('[Claude Sheets] Schwab: single account response - select All Brokerage Accounts to sync');
                            }
                        } catch (e) { console.log('[Claude Sheets] Schwab: error processing response', e); }
                    });
                }
                return originalSend.apply(this, arguments);
            };
        },
        extractPositions(data) {
            const positions = [];
            if (!Array.isArray(data.accounts)) return positions;
            for (const account of data.accounts) {
                const accountName = account.accountDetail?.nickname || 'Unknown';
                const accountId = account.accountId || '';
                for (const group of account.groupedPositions || []) {
                    if (group.securityType !== 1 && group.securityType !== 2) continue; // Equity, ETF only
                    for (const row of group.holdingsRows || []) {
                        const ticker = row.symbol?.symbol;
                        const quantity = row.qty?.qty;
                        const rawBasis = row.costBasis?.cstBasis;
                        if (!ticker || !quantity) continue;
                        // v3.5 (audit 188, A2): an "Incomplete" basis used to be dropped here, and the
                        // function then read the HELD position as sold. It is sent with a null basis;
                        // the function counts it present and leaves the row's cost fields alone.
                        const hasBasis = typeof rawBasis === 'number' && !isNaN(rawBasis);
                        positions.push({
                            ticker, account: accountName, accountId, quantity,
                            costBasis: hasBasis ? rawBasis : null,
                            costPerShare: hasBasis ? (row.costBasis?.cstPerShr || (rawBasis / quantity)) : null,
                            securityType: SCHWAB_SECURITY_TYPES[group.securityType] || 'Unknown'
                        });
                    }
                }
            }
            return positions;
        },
        // v3.5 (audit 188, A1): the accounts the response SPOKE FOR - only those whose holdings
        // section was actually delivered. The function closes every row of a named account that
        // sent no positions; an account whose section is missing is not named, so a partial
        // response cannot close anything.
        extractAccounts(data) {
            if (!Array.isArray(data.accounts)) return [];
            return data.accounts
                .filter(account => Array.isArray(account.groupedPositions))
                .map(account => ({ accountId: account.accountId || '', nickname: account.accountDetail?.nickname || 'Unknown' }));
        },
        async sync(positions, accounts = []) {
            if (schwab.synced) return;
            const apiKey = requireKey(); if (!apiKey) return;
            try {
                const r = await postToFunction('schwabCostBasisProxy', { positions, accounts, timestamp: new Date().toISOString() }, apiKey);
                schwab.synced = true;
                const closed = r.orphansClosed ? `, ${r.orphansClosed} closed` : '';
                toast(`Schwab: synced ${r.positionsProcessed ?? positions.length} positions${closed}`);
            } catch (error) { toast(`Schwab: ${error.message}`, true, 10000); }
        },
        // v3.5, Tom: "It would be better though if the menu item would first bring you to the
        // Positions view, then select All Brokerage Accounts." Off Positions: leave a dated flag
        // and navigate; the Positions load picks it up. On Positions: select at once.
        syncFromAnywhere() {
            if (schwab.onPositions()) { schwab.selectAllAccounts(); return; }
            GM_setValue(SCHWAB_PENDING_KEY, String(Date.now()));
            toast('Schwab: going to Positions...');
            location.href = SCHWAB_POSITIONS_URL;
        },
        // Runs on every Schwab page load. Does nothing unless the menu left a FRESH flag - a
        // stale one (an abandoned navigation, a closed tab) is cleared, never acted on.
        resumePendingSelect() {
            const raw = GM_getValue(SCHWAB_PENDING_KEY, '');
            if (!raw) return;
            GM_setValue(SCHWAB_PENDING_KEY, '');
            if (!schwab.onPositions() || Date.now() - Number(raw) > SCHWAB_PENDING_TTL_MS) return;
            // The account selector renders after the SPA boots; poll for it, bounded.
            let tries = 0;
            const timer = setInterval(() => {
                tries++;
                if (document.querySelector('#account-selector')) { clearInterval(timer); schwab.selectAllAccounts(); }
                else if (tries >= 40) { clearInterval(timer); toast('Schwab: Positions loaded but no account selector appeared', true); }
            }, 500);
        },
        selectAllAccounts() {
            const button = document.querySelector('#account-selector');
            if (!button) { toast('Schwab: account selector not found - are you on Positions?', true); return; }
            const text = button.textContent || '';
            if (text.includes('All') || text.includes('Brokerage Accounts')) { toast('Schwab: all accounts already selected'); return; }
            button.click();
            setTimeout(() => {
                const link = document.querySelector('#account-selector-additional-links-0-0-0');
                if (link) link.click();
                else { toast('Schwab: "All Brokerage Accounts" link not found', true); button.click(); }
            }, 500);
        }
    };

    // ============ HANDLER: balance readings (Vanguard, Merrill, Betterment) ============
    // Each reader returns {value, asOf} or null while the page is still loading, or
    // {skip: reason} for a page whose number must NOT be recorded (an intraday value).
    const READERS = {
        // v3.4. Vanguard's dashboard: the account's balance and the "Value as of" line
        // in the greeting - "September 3, 2026, 7:00 p.m., Eastern time". Both live in
        // shadow DOM (gyd-greetings-widget, gyd-accounts-widget). Only a value stated
        // AFTER the 4 p.m. ET close is a close; an intraday figure is skipped, not sent.
        // Why this reader exists: Plaid delivers Vanguard's PREVIOUS trading day (charter
        // §4a, measured three times), so the sheet's Vanguard row is a day behind until
        // the next pull. The site is current; a reading from it is trust 3 (Broker Tool)
        // under Vanguard's own date, and the lagged Plaid write for that day then yields.
        vanguard: {
            test: () => /(^|\.)vanguard\.com$/.test(location.hostname) && /\/portfolio\/dashboard/.test(location.pathname),
            read() {
                const greet = document.querySelector('gyd-greetings-widget');
                const accountsWidget = document.querySelector('gyd-accounts-widget');
                const g = greet && greet.shadowRoot;
                const a = accountsWidget && accountsWidget.shadowRoot;
                if (!g || !a) return null;
                const asOfText = [...g.querySelectorAll('.greeting-link')]
                    .map(d => d.textContent.replace(/\s+/g, ' ')).find(t => /Value as of/i.test(t)) || '';
                const m = asOfText.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i);
                if (!m) return null;
                const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
                const asOf = `${months.indexOf(m[1].toLowerCase()) + 1}/${m[2]}/${m[3]}`;
                const hour = (parseInt(m[4], 10) % 12) + (m[6].toLowerCase() === 'p' ? 12 : 0);
                const accounts = [...a.querySelectorAll('.individual-account-container')].map(c => {
                    const name = c.querySelector('.account-name a');
                    const balance = c.querySelector('gyd-value-change.balance span');
                    return name && balance ? { name: name.textContent.trim(), value: balance.textContent.trim() } : null;
                }).filter(x => x && MONEY.test(x.value));
                if (!accounts.length) return null;
                // The brokerage account: the one configured (last digits of the account
                // number), else the single non-zero account; two non-zero accounts with
                // nothing configured is a question, not a guess.
                const wanted = String(setting('vanguardBalanceAccount') || '').replace(/\D/g, '');
                const byNumber = wanted ? accounts.find(x => x.name.replace(/\D/g, '').endsWith(wanted)) : null;
                const nonZero = accounts.filter(x => Number(x.value.replace(/[$,]/g, '')) > 0);
                const chosen = byNumber || (nonZero.length === 1 ? nonZero[0] : null);
                if (!chosen) return { skip: `Vanguard: ${nonZero.length} accounts with a balance - set "Vanguard balance account" (last digits) from the Tampermonkey menu` };
                if (hour < 16) return { skip: `Vanguard: value as of ${m[4]}:${m[5]} ${m[6]}.m. ET is intraday, not the close - not recorded; visit after 4 p.m. ET` };
                return { value: chosen.value, asOf };
            }
        },
        merrill: {
            test: () => location.hostname === 'www.benefits.ml.com',
            read() {
                const span = document.querySelector('#spanEmployerTotalMarketValue') ||
                             document.querySelector('span.bol-ao-cab__balance');
                const money = span && span.textContent.trim();
                const note = document.querySelector('#divPPTFootNotes');
                const m = note && note.textContent.match(/previous business day\s+(\d{1,2}\/\d{1,2}\/\d{4})/);
                if (!money || !MONEY.test(money) || !m) return null;
                return { value: money, asOf: m[1] };
            }
        },
        betterment: {
            test: () => location.hostname === 'wwws.betterment.com' && location.pathname.startsWith('/app/performance'),
            read() {
                const label = [...document.querySelectorAll('span')].find(s =>
                    s.textContent.trim() === 'Balance' && s.nextElementSibling &&
                    MONEY.test(s.nextElementSibling.textContent.trim()));
                const m = document.body.innerText.match(/As of\s+(\d{2}\/\d{2}\/\d{4})/);
                if (!label || !m) return null;
                return { value: label.nextElementSibling.textContent.trim(), asOf: m[1] };
            }
        }
    };
    const readings = {
        POLL_MS: 500, POLL_LIMIT_MS: 20000, WATCH_MS: 1000,
        which: () => Object.keys(READERS).find(k => READERS[k].test()),
        // The handler owns the whole site (the SPA case above); which() says whether THIS
        // URL is a page a reader can read.
        test: () => location.hostname === 'www.benefits.ml.com' || location.hostname === 'wwws.betterment.com',
        // (vanguard.com is the Vanguard handler's site; it calls readings.start() itself.)
        menu: [['Read balance now', () => readings.run(true)]],
        start() {
            let lastUrl = null;
            const check = () => {
                if (location.href === lastUrl) return;
                lastUrl = location.href;
                if (readings.which()) readings.run(false);
            };
            check();
            setInterval(check, readings.WATCH_MS);
        },
        run(forced) {
            const name = readings.which();
            if (!name) { if (forced) toast('Not a page this script reads — open the dashboard (Vanguard), Performance (Betterment) or Accounts/Home (Merrill)', true); return; }
            const began = Date.now();
            const timer = setInterval(() => {
                const reading = READERS[name].read();
                if (reading && reading.skip) { clearInterval(timer); toast(reading.skip, true, 8000); return; }
                if (reading) { clearInterval(timer); readings.post(name, reading, forced); return; }
                if (Date.now() - began > readings.POLL_LIMIT_MS) {
                    clearInterval(timer);
                    markTab(false);
                    toast(`${name}: balance or as-of date not found on this page after ${readings.POLL_LIMIT_MS / 1000}s — nothing sent`, true, 10000);
                }
            }, readings.POLL_MS);
        },
        async post(name, reading, forced) {
            const apiKey = requireKey(); if (!apiKey) return;
            const key = `${name}|${reading.asOf}|${reading.value}`;
            if (!forced && GM_getValue('lastReadingSent', '') === key) {
                markTab(true);
                toast(`${name} ${reading.value} as of ${reading.asOf} — already sent`, false, 4000);
                return;
            }
            try {
                const result = await postToFunction('brokerReadingsProxy',
                    { institution: name, asOf: reading.asOf, value: reading.value, page: location.href, readAt: new Date().toISOString() }, apiKey);
                GM_setValue('lastReadingSent', key);
                markTab(true);
                toast(`${name} ${reading.value} as of ${reading.asOf} → ${result.duplicate ? 'already on the sheet' : 'sent'}`);
            } catch (error) { markTab(false); toast(`${name}: ${error.message}`, true, 10000); }
        }
    };

    // ============ DISPATCH: exactly one handler for the site you are on ============
    const handler = [vanguard, schwab, readings].find(h => h.test());
    GM_registerMenuCommand('Set API key (all sites)', () => askAndStore('apiKey', 'Cloud Function API key'));
    GM_registerMenuCommand(`Auto-login after autofill: ${setting('autoLogin') === 'on' ? 'ON (click to turn off)' : 'off (click to turn on)'}`, () => {
        GM_setValue('autoLogin', setting('autoLogin') === 'on' ? 'off' : 'on');
        toast(`Auto-login after autofill is now ${setting('autoLogin') === 'on' ? 'ON' : 'off'} — reload the page`);
    });
    if (handler) {
        for (const [label, fn] of handler.menu) GM_registerMenuCommand(label, fn);
        handler.start();
    }
    // v3.6: the login handler is additive — it runs beside the site handler on a login page.
    if (login.test()) login.start();
})();
