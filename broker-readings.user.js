// ==UserScript==
// @name         Broker Balance Readings (Merrill + Betterment)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Reads the account balance and the institution's own as-of date off the page you are already on and files it to the claude-sheets brokerReadingsProxy. Never navigates.
// @author       Tom
// @homepageURL  https://github.com/tbarthen/userscripts
// @updateURL    https://raw.githubusercontent.com/tbarthen/userscripts/main/broker-readings.user.js
// @downloadURL  https://raw.githubusercontent.com/tbarthen/userscripts/main/broker-readings.user.js
// @match        https://www.benefits.ml.com/Accounts/Home*
// @match        https://wwws.betterment.com/app/performance*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      us-central1-claude-sheets.cloudfunctions.net
// ==/UserScript==

/*
 * ONE script for both institutions, PASSIVE by design (2026-09-03).
 *
 *   Merrill (Benefits OnLine)  https://www.benefits.ml.com/Accounts/Home
 *     value : #spanEmployerTotalMarketValue (fallback span.bol-ao-cab__balance)
 *     as-of : footnote "...closing price from the previous business day M/D/YYYY"
 *             -> the PRIOR close, and the date the reading is filed under.
 *   Betterment                 https://wwws.betterment.com/app/performance
 *     value : the span whose text is exactly "Balance" and whose next sibling is $x,xxx.xx
 *     as-of : "As of MM/DD/YYYY" anywhere on the page.
 *
 * Both pages render client-side, so the reader polls (up to 20s) for the value and
 * the date together; a page that never yields both is reported, not guessed.
 * The reading is posted once per (institution, as-of, value): the Cloud Function
 * de-duplicates too, but not re-sending is cheaper. Apps Script files it into
 * PortfolioValues as `Broker Tool` under the as-of date (menu: File Broker Readings,
 * and automatically on the daily pass).
 *
 * No secrets in this file: the API key is in Tampermonkey storage, set once from
 * the menu ("Set API key"). It is the same key the Vanguard export uses.
 * Selectors and anchors: docs/portfolio/broker_readings_scrape_notes.md.
 */
(function () {
    'use strict';

    const CLOUD_FUNCTION_URL = 'https://us-central1-claude-sheets.cloudfunctions.net/brokerReadingsProxy';
    const POLL_MS = 500, POLL_LIMIT_MS = 20000;
    const MONEY = /^\$[\d,]+\.\d{2}$/;
    const TOAST_ID = 'broker-readings-toast';

    // ============ SETTINGS ============
    function setting(name) { return (GM_getValue(name, '') || '').trim(); }
    GM_registerMenuCommand('Read balance now', () => start(true));
    GM_registerMenuCommand('Set API key', () => {
        const value = window.prompt(`Cloud Function API key${setting('apiKey') ? ' (currently set; blank keeps it)' : ''}:`, '');
        if (value && value.trim()) { GM_setValue('apiKey', value.trim()); toast('API key saved'); }
    });

    // ============ READERS: each returns {value, asOf} or null while the page is still loading ============
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

    // ============ UI ============
    function toast(message, isError = false, ms = 6000) {
        document.getElementById(TOAST_ID)?.remove();
        const el = document.createElement('div');
        el.id = TOAST_ID;
        el.textContent = message;
        el.style.cssText = `position:fixed;top:20px;right:20px;padding:14px 20px;` +
            `background:${isError ? '#d32f2f' : '#1a73e8'};color:white;border-radius:8px;` +
            `font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;z-index:2147483647;` +
            `box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:420px;`;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), ms);
        console.log(`[Broker Readings] ${message}`);
    }

    // ============ FLOW ============
    function start(forced) {
        const name = Object.keys(READERS).find(k => READERS[k].test());
        if (!name) return;
        const reader = READERS[name];
        const began = Date.now();
        const timer = setInterval(() => {
            const reading = reader.read();
            if (reading) { clearInterval(timer); post(name, reading, forced); return; }
            if (Date.now() - began > POLL_LIMIT_MS) {
                clearInterval(timer);
                toast(`${name}: balance or as-of date not found on this page after ${POLL_LIMIT_MS / 1000}s — nothing sent`, true, 10000);
            }
        }, POLL_MS);
    }

    function post(name, reading, forced) {
        const apiKey = setting('apiKey');
        if (!apiKey) { toast('Not configured: set the API key from the Tampermonkey menu', true); return; }
        const key = `${name}|${reading.asOf}|${reading.value}`;
        if (!forced && GM_getValue('lastSent', '') === key) {
            toast(`${name} ${reading.value} as of ${reading.asOf} — already sent`, false, 4000);
            return;
        }
        GM_xmlhttpRequest({
            method: 'POST',
            url: CLOUD_FUNCTION_URL,
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
            data: JSON.stringify({ institution: name, asOf: reading.asOf, value: reading.value,
                                   page: location.href, readAt: new Date().toISOString() }),
            onload(response) {
                let result = null;
                try { result = JSON.parse(response.responseText); } catch {}
                if (response.status === 200 && result && result.success) {
                    GM_setValue('lastSent', key);
                    toast(`${name} ${reading.value} as of ${reading.asOf} → ${result.duplicate ? 'already on the sheet' : 'sent'}`);
                } else {
                    toast(`${name}: send failed (${response.status}) ${result && result.error ? result.error : ''}`, true, 10000);
                }
            },
            onerror() { toast(`${name}: network error sending the reading`, true, 10000); }
        });
    }

    start(false);
})();
