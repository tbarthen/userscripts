// ==UserScript==
// @name         Claude Sheets Broker Sync
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  One script for every broker site: Vanguard cost basis, Schwab cost basis, Merrill and Betterment balance readings, all to the claude-sheets Cloud Functions with ONE API key. Passive: never navigates, never clicks.
// @author       Tom
// @homepageURL  https://github.com/tbarthen/userscripts
// @updateURL    https://raw.githubusercontent.com/tbarthen/userscripts/main/claude-sheets-broker-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/tbarthen/userscripts/main/claude-sheets-broker-sync.user.js
// @match        https://*.vanguard.com/*
// @match        https://vanguard.com/*
// @match        https://client.schwab.com/*
// @match        https://www.benefits.ml.com/Accounts/Home*
// @match        https://wwws.betterment.com/app/performance*
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
 *               Menu: "Select All Brokerage Accounts", "Reset sync".
 *   Merrill     benefits.ml.com/Accounts/Home: total market value + the footnote's
 *               "previous business day M/D/YYYY" (the PRIOR close) → brokerReadingsProxy.
 *   Betterment  betterment.com/app/performance: the "Balance" figure + "As of MM/DD/YYYY"
 *               → brokerReadingsProxy.
 *
 * NOTHING NAVIGATES. The v1.x scripts redirected pages and clicked selectors, which made
 * the sites unusable with them enabled; every action here happens on the page you chose
 * to open, or from the menu.
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
               ['Set Vanguard account ID', () => askAndStore('vanguardAccountId', 'Vanguard account ID')]],
        start() { if (location.hostname === 'cost-basis.web.vanguard.com') setTimeout(() => vanguard.run(), 2000); },
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
    const schwab = {
        test: () => location.hostname === 'client.schwab.com',
        synced: false,
        menu: [['Select All Brokerage Accounts', () => schwab.selectAllAccounts()],
               ['Reset sync (allow re-sync)', () => { schwab.synced = false; toast('Schwab: sync reset - reload Positions to sync again'); }]],
        start() {
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
                                if (positions.length) schwab.sync(positions);
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
                        const costBasis = row.costBasis?.cstBasis;
                        if (!ticker || !quantity) continue;
                        if (typeof costBasis !== 'number' || isNaN(costBasis)) continue;   // "Incomplete"
                        positions.push({
                            ticker, account: accountName, accountId, quantity, costBasis,
                            costPerShare: row.costBasis?.cstPerShr || (costBasis / quantity),
                            securityType: SCHWAB_SECURITY_TYPES[group.securityType] || 'Unknown'
                        });
                    }
                }
            }
            return positions;
        },
        async sync(positions) {
            if (schwab.synced) return;
            const apiKey = requireKey(); if (!apiKey) return;
            try {
                const r = await postToFunction('schwabCostBasisProxy', { positions, timestamp: new Date().toISOString() }, apiKey);
                schwab.synced = true;
                toast(`Schwab: synced ${r.rowsWritten || (r.updated + r.inserted) || positions.length} positions`);
            } catch (error) { toast(`Schwab: ${error.message}`, true, 10000); }
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

    // ============ HANDLER: balance readings (Merrill, Betterment) ============
    // Each reader returns {value, asOf} or null while the page is still loading.
    const READERS = {
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
        POLL_MS: 500, POLL_LIMIT_MS: 20000,
        which: () => Object.keys(READERS).find(k => READERS[k].test()),
        test: () => !!readings.which(),
        menu: [['Read balance now', () => readings.run(true)]],
        start() { readings.run(false); },
        run(forced) {
            const name = readings.which();
            if (!name) return;
            const began = Date.now();
            const timer = setInterval(() => {
                const reading = READERS[name].read();
                if (reading) { clearInterval(timer); readings.post(name, reading, forced); return; }
                if (Date.now() - began > readings.POLL_LIMIT_MS) {
                    clearInterval(timer);
                    toast(`${name}: balance or as-of date not found on this page after ${readings.POLL_LIMIT_MS / 1000}s — nothing sent`, true, 10000);
                }
            }, readings.POLL_MS);
        },
        async post(name, reading, forced) {
            const apiKey = requireKey(); if (!apiKey) return;
            const key = `${name}|${reading.asOf}|${reading.value}`;
            if (!forced && GM_getValue('lastReadingSent', '') === key) {
                toast(`${name} ${reading.value} as of ${reading.asOf} — already sent`, false, 4000);
                return;
            }
            try {
                const result = await postToFunction('brokerReadingsProxy',
                    { institution: name, asOf: reading.asOf, value: reading.value, page: location.href, readAt: new Date().toISOString() }, apiKey);
                GM_setValue('lastReadingSent', key);
                toast(`${name} ${reading.value} as of ${reading.asOf} → ${result.duplicate ? 'already on the sheet' : 'sent'}`);
            } catch (error) { toast(`${name}: ${error.message}`, true, 10000); }
        }
    };

    // ============ DISPATCH: exactly one handler for the site you are on ============
    const handler = [vanguard, schwab, readings].find(h => h.test());
    GM_registerMenuCommand('Set API key (all sites)', () => askAndStore('apiKey', 'Cloud Function API key'));
    if (handler) {
        for (const [label, fn] of handler.menu) GM_registerMenuCommand(label, fn);
        handler.start();
    }
})();
