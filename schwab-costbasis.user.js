// ==UserScript==
// @name         Schwab Cost Basis Sync
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Sync Schwab positions (HoldingV2) to the claude-sheets Cloud Function. Never redirects; syncs when you view Positions with All Brokerage Accounts selected, or from the Tampermonkey menu.
// @author       Tom
// @homepageURL  https://github.com/tbarthen/userscripts
// @updateURL    https://raw.githubusercontent.com/tbarthen/userscripts/main/schwab-costbasis.user.js
// @downloadURL  https://raw.githubusercontent.com/tbarthen/userscripts/main/schwab-costbasis.user.js
// @match        https://client.schwab.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      us-central1-claude-sheets.cloudfunctions.net
// ==/UserScript==

/*
 * v2.0 (2026-09-03). Two changes from v1.1, both deliberate:
 *
 *  1. NO FORCED NAVIGATION. v1.1 redirected the summary page to Positions 1.5s after
 *     load and then clicked the account selector open to pick "All Brokerage Accounts",
 *     which made the site unusable with the script enabled (so it was disabled). Now the
 *     XHR intercept is passive: it syncs when YOU are on Positions with All Brokerage
 *     Accounts selected. The Tampermonkey menu has "Select All Brokerage Accounts" for
 *     when you want the click done for you, and "Reset sync (allow re-sync)".
 *
 *  2. NO SECRETS IN THE FILE. The API key lives in Tampermonkey's per-script storage
 *     (GM_setValue), entered once through the menu ("Set API key"). This file is
 *     committed to the repo.
 */
(function () {
    'use strict';

    const CLOUD_FUNCTION_URL = 'https://us-central1-claude-sheets.cloudfunctions.net/schwabCostBasisProxy';
    const DEBUG = true;
    let hasSynced = false; // one sync per page load

    function log(...args) { if (DEBUG) console.log('[Schwab Sync]', ...args); }

    // ============ SETTINGS (Tampermonkey storage, never in this file) ============
    function setting(name) { return (GM_getValue(name, '') || '').trim(); }
    GM_registerMenuCommand('Set API key', () => {
        const value = window.prompt(`Cloud Function API key${setting('apiKey') ? ' (currently set; blank keeps it)' : ''}:`, '');
        if (value && value.trim()) { GM_setValue('apiKey', value.trim()); showToast('API key saved'); }
    });
    GM_registerMenuCommand('Select All Brokerage Accounts', selectAllAccounts);
    GM_registerMenuCommand('Reset sync (allow re-sync)', () => { hasSynced = false; showToast('Sync reset - reload Positions to sync again'); });

    // ============ UI ============
    function showToast(message, isError = false) {
        const toast = document.createElement('div');
        toast.style.cssText = `position:fixed;top:20px;right:20px;padding:16px 24px;` +
            `background:${isError ? '#d32f2f' : '#2e7d32'};color:white;border-radius:8px;` +
            `font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;font-weight:500;` +
            `z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s ease;`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
    }

    // ============ EXTRACT ============
    const SECURITY_TYPES = { 1: 'Equity', 2: 'ETF', 3: 'MutualFund', 9: 'Cash' };

    function extractPositions(data) {
        const positions = [];
        if (!Array.isArray(data.accounts)) { log('No accounts array found'); return positions; }
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
                    if (typeof costBasis !== 'number' || isNaN(costBasis)) { log(`Skipping ${ticker} - incomplete cost basis`); continue; }
                    positions.push({
                        ticker, account: accountName, accountId, quantity, costBasis,
                        costPerShare: row.costBasis?.cstPerShr || (costBasis / quantity),
                        securityType: SECURITY_TYPES[group.securityType] || 'Unknown'
                    });
                }
            }
        }
        return positions;
    }

    // ============ SYNC ============
    function syncToCloudFunction(positions) {
        if (positions.length === 0) { showToast('No positions with complete cost basis found', true); return; }
        if (hasSynced) { log('Already synced this page load, skipping'); return; }
        const apiKey = setting('apiKey');
        if (!apiKey) { showToast('Not configured: set the API key from the Tampermonkey menu', true); return; }
        log('Syncing positions:', positions);
        GM_xmlhttpRequest({
            method: 'POST',
            url: CLOUD_FUNCTION_URL,
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
            data: JSON.stringify({ positions, timestamp: new Date().toISOString() }),
            onload(response) {
                log('Response:', response.status, response.responseText);
                if (response.status === 200) {
                    hasSynced = true;
                    let count = positions.length;
                    try { const r = JSON.parse(response.responseText); count = r.rowsWritten || (r.updated + r.inserted) || count; } catch {}
                    showToast(`Synced ${count} Schwab positions`);
                } else {
                    showToast(`Sync failed: ${response.status}`, true);
                }
            },
            onerror(error) { log('Error:', error); showToast('Sync failed: Network error', true); }
        });
    }

    // ============ PASSIVE INTERCEPT of the page's own HoldingV2 request ============
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._url = url;
        return originalOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function (body) {
        if (this._url && this._url.includes('/Holdings/HoldingV2')) {
            log('Intercepting HoldingV2 request');
            this.addEventListener('load', function () {
                try {
                    const data = JSON.parse(this.responseText);
                    log('HoldingV2 response received, accounts:', data.accounts?.length);
                    if (data.accounts && data.accounts.length > 1) {          // All Brokerage Accounts selected
                        const positions = extractPositions(data);
                        log(`Extracted ${positions.length} positions with complete cost basis`);
                        if (positions.length > 0) syncToCloudFunction(positions);
                    } else {
                        log('Single account response - select All Brokerage Accounts to sync');
                    }
                } catch (e) { log('Error processing response:', e); }
            });
        }
        return originalSend.apply(this, arguments);
    };

    // ============ ON DEMAND: the account-selector click, from the menu only ============
    function selectAllAccounts() {
        const selectorButton = document.querySelector('#account-selector');
        if (!selectorButton) { showToast('Account selector not found - are you on Positions?', true); return; }
        const text = selectorButton.textContent || '';
        if (text.includes('All') || text.includes('Brokerage Accounts')) { showToast('All accounts already selected'); return; }
        selectorButton.click();
        setTimeout(() => {
            const allAccountsLink = document.querySelector('#account-selector-additional-links-0-0-0');
            if (allAccountsLink) { log('Clicking "Show All Brokerage Accounts"'); allAccountsLink.click(); }
            else { showToast('All Brokerage Accounts link not found', true); selectorButton.click(); }
        }, 500);
    }

    log('Schwab Cost Basis Sync v2.0 loaded (passive)');
})();
