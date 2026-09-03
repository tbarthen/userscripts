// ==UserScript==
// @name         Vanguard Cost Basis Export
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Export Vanguard cost basis lots to the claude-sheets Cloud Function. Never redirects; runs on the cost-basis page or from the Tampermonkey menu.
// @author       Tom
// @homepageURL  https://github.com/tbarthen/userscripts
// @updateURL    https://raw.githubusercontent.com/tbarthen/userscripts/main/vanguard-costbasis.user.js
// @downloadURL  https://raw.githubusercontent.com/tbarthen/userscripts/main/vanguard-costbasis.user.js
// @match        https://dashboard.web.vanguard.com/*
// @match        https://holdings.web.vanguard.com/*
// @match        https://cost-basis.web.vanguard.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      personal1.vanguard.com
// @connect      us-central1-claude-sheets.cloudfunctions.net
// ==/UserScript==

/*
 * v2.0 (2026-09-03). Two changes from v1.2, both deliberate:
 *
 *  1. NO REDIRECT. v1.2 sent every dashboard load to the cost-basis page 1.5s after
 *     login, which made the site unusable with the script enabled (so it was disabled).
 *     Now: landing on cost-basis.web.vanguard.com exports; anywhere else on Vanguard,
 *     the Tampermonkey menu has "Export cost basis now". Navigate freely.
 *
 *  2. NO SECRETS IN THE FILE. The API key and account ID live in Tampermonkey's
 *     per-script storage (GM_setValue), entered once through the menu
 *     ("Set API key" / "Set account ID"). This file is committed to the repo.
 */
(function () {
    'use strict';

    const CLOUD_FUNCTION_URL = 'https://us-central1-claude-sheets.cloudfunctions.net/vanguardCostBasisProxy';
    const VANGUARD_API = 'https://personal1.vanguard.com/smn-client-cost-basis-accounting-webservice/costbasis/external/lots?request=unrealized';
    const TOAST_ID = 'vg-export-toast';

    // ============ SETTINGS (Tampermonkey storage, never in this file) ============
    function setting(name) { return (GM_getValue(name, '') || '').trim(); }
    function askAndStore(name, label) {
        const current = setting(name);
        const value = window.prompt(`${label}${current ? ' (currently set; blank keeps it)' : ''}:`, '');
        if (value && value.trim()) { GM_setValue(name, value.trim()); showToast(`${label} saved`); }
    }
    GM_registerMenuCommand('Export cost basis now', runExport);
    GM_registerMenuCommand('Set API key', () => askAndStore('apiKey', 'Cloud Function API key'));
    GM_registerMenuCommand('Set account ID', () => askAndStore('accountId', 'Vanguard account ID'));

    // ============ ROUTING: the cost-basis page exports; nothing else navigates ============
    if (location.hostname === 'cost-basis.web.vanguard.com') {
        setTimeout(runExport, 2000);
    }

    // ============ UI ============
    function showToast(message, isError = false) {
        const existing = document.getElementById(TOAST_ID);
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = TOAST_ID;
        toast.textContent = message;
        toast.style.cssText = `position:fixed;top:20px;right:20px;padding:16px 24px;` +
            `background:${isError ? '#d93025' : '#1a73e8'};color:white;border-radius:8px;` +
            `font-size:14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;` +
            `z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.3);`;
        document.body.appendChild(toast);
        console.log(`[Vanguard Export] ${message}`);
    }

    // ============ EXPORT ============
    async function runExport() {
        const apiKey = setting('apiKey');
        const accountId = setting('accountId');
        if (!apiKey || !accountId) {
            showToast('Not configured: set the API key and account ID from the Tampermonkey menu', true);
            return;
        }
        showToast('Fetching cost basis data...');
        try {
            const data = await fetchVanguardData(accountId);
            const lotCount = (data.coveredLots?.length || 0) + (data.nonCoveredLots?.length || 0);
            showToast(`Sending ${lotCount} lots to Sheets...`);
            const result = await postToCloudFunction(data, apiKey);
            showToast(`Done: ${result.inserted} new, ${result.updated} updated`);
            setTimeout(() => document.getElementById(TOAST_ID)?.remove(), 5000);
        } catch (error) {
            showToast(`Error: ${error.message}`, true);
            console.error('[Vanguard Export] Error:', error);
        }
    }

    function fetchVanguardData(accountId) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: VANGUARD_API,
                headers: {
                    'accept': 'application/json',
                    'consumer-application-code': 'HDV',
                    'x-account-id': accountId,
                    'x-holding-id': '0'
                },
                onload(response) {
                    if (response.status === 200) {
                        try {
                            const data = JSON.parse(response.responseText);
                            data.accountId = accountId;
                            resolve(data);
                        } catch { reject(new Error('Failed to parse Vanguard response')); }
                    } else if (response.status === 401) {
                        reject(new Error('Session expired - please log in again'));
                    } else {
                        reject(new Error(`Vanguard API returned ${response.status}`));
                    }
                },
                onerror() { reject(new Error('Network error calling Vanguard API')); }
            });
        });
    }

    function postToCloudFunction(data, apiKey) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: CLOUD_FUNCTION_URL,
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
                data: JSON.stringify(data),
                onload(response) {
                    try {
                        const result = JSON.parse(response.responseText);
                        result.success ? resolve(result) : reject(new Error(result.error || 'Cloud Function error'));
                    } catch { reject(new Error('Failed to parse Cloud Function response')); }
                },
                onerror() { reject(new Error('Network error calling Cloud Function')); }
            });
        });
    }
})();
