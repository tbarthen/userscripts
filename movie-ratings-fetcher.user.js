// ==UserScript==
// @name         Movie Ratings Fetcher (RT via OMDb)
// @namespace    http://tampermonkey.net/
// @version      8.3
// @description  Enter a movie list on Google, or browse Tubi to see RT/IMDb ratings load on view
// @author       You
// @match        https://www.google.com/*
// @match        https://tubitv.com/*
// @match        https://www.tubi.tv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      omdbapi.com
// @connect      rottentomatoes.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* ---------------------------------------------------------------
     * Config + persistence
     * ------------------------------------------------------------- */
    const DEFAULT_KEY = '';   // set yours via the "Set OMDb API key" menu
    const CACHE_KEY   = 'rtCache_v5';
    const CACHE_TTL   = 7 * 24 * 60 * 60 * 1000;   // 7 days
    const CONCURRENCY = 4;
    const REQ_TIMEOUT = 12000;
    const GOOD        = 80;   // green / full brightness
    const BAD         = 70;   // below this is red

    const getKey = () => GM_getValue('omdbKey', DEFAULT_KEY);

    let cache = {};
    try { cache = JSON.parse(GM_getValue(CACHE_KEY, '{}')) || {}; } catch (e) { cache = {}; }

    let saveTimer;
    function saveCache() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => GM_setValue(CACHE_KEY, JSON.stringify(cache)), 600);
    }
    function cacheGet(k) {
        const e = cache[k];
        if (!e) return null;
        if (Date.now() - e.t > CACHE_TTL) { delete cache[k]; return null; }
        return e.v;
    }
    function cacheSet(k, v) { cache[k] = { t: Date.now(), v }; saveCache(); }

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Set OMDb API key', () => {
            const k = prompt('OMDb API key:', getKey());
            if (k && k.trim()) { GM_setValue('omdbKey', k.trim()); alert('Saved.'); }
        });
        GM_registerMenuCommand('Clear ratings cache', () => {
            cache = {}; GM_setValue(CACHE_KEY, '{}'); alert('Cache cleared.');
        });
        GM_registerMenuCommand('Toggle dimming of low-rated titles', () => {
            GM_setValue('rtDim', !GM_getValue('rtDim', true));
            location.reload();
        });
        GM_registerMenuCommand('Toggle fill debug logging', () => {
            GM_setValue('rtDebug', !GM_getValue('rtDebug', false));
            location.reload();
        });
        GM_registerMenuCommand('Reset hide filters', () => {
            GM_setValue('rtHideSoft', false);
            GM_setValue('rtHideHard', false);
            GM_setValue('rtHideHero', false);
            GM_setValue('rtHideDupes', false);
            location.reload();
        });
    }

    /* ---------------------------------------------------------------
     * Utilities
     * ------------------------------------------------------------- */
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    const ok = (v) => v && v !== 'N/A' && v !== 'undefined';

    function gmFetch(url, opts = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: opts.timeout || REQ_TIMEOUT,
                headers: opts.headers,
                onload: resolve,
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timed out')),
                onabort: () => reject(new Error('Aborted'))
            });
        });
    }

    async function mapPool(items, limit, fn) {
        const out = new Array(items.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (cursor < items.length) {
                const i = cursor++;
                out[i] = await fn(items[i], i);
            }
        });
        await Promise.all(workers);
        return out;
    }

    function scoreNum(v) {
        const m = String(v || '').match(/(\d{1,3})/);
        return m ? parseInt(m[1], 10) : -1;
    }

    const best = (r) => Math.max(scoreNum(r.critic), scoreNum(r.audience));

    function scoreColor(v) {
        const n = scoreNum(v);
        if (n < 0)      return '#9aa0a6';
        if (n >= GOOD)  return '#1e8e3e';
        if (n >= BAD)   return '#f9ab00';
        return '#d93025';
    }

    // Green >=80 on either score, red <70, amber between, gray when unknown.
    // dim: 0 = leave bright, 0.5 = light veil, 1 = full veil.
    function tone(r) {
        const b = best(r);
        if (b < 0)     return { bg: 'rgba(0,0,0,.88)',     bd: '#666',    dot: '⚪', dim: 0.5 };
        if (b >= GOOD) return { bg: 'rgba(20,110,45,.94)', bd: '#3ddc6b', dot: '🟢', dim: 0   };
        if (b < BAD)   return { bg: 'rgba(145,25,25,.94)', bd: '#ff6b6b', dot: '🔴', dim: 1   };
        return { bg: 'rgba(135,92,0,.93)', bd: '#f9ab00', dot: '🟡', dim: 1 };
    }

    // RT slugs look like /m/the_dark_knight — fallback when tomatoURL is absent (paid-tier field).
    function rtGuess(title) {
        const slug = String(title).toLowerCase()
            .replace(/&/g, ' and ')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return slug ? `https://www.rottentomatoes.com/m/${slug}` : null;
    }

    function extractScores(html) {
        const out = {};
        const block = html.match(/<script[^>]+id="media-scorecard-json"[^>]*>([\s\S]*?)<\/script>/i);
        if (block) {
            try {
                const j = JSON.parse(block[1]);
                const a = j.audienceScore || {};
                const c = j.criticsScore || {};
                if (a.score) out.audience = String(a.score).replace('%', '');
                if (c.score) out.critic   = String(c.score).replace('%', '');
            } catch (e) { /* fall through to regex */ }
        }
        if (!out.audience) {
            const pats = [
                /"audienceScore"\s*:\s*\{[^{}]*?"score"\s*:\s*"?(\d{1,3})/i,
                /"scorePercent"\s*:\s*"(\d{1,3})%"/i,
                /audience[_-]?score[^0-9%]{0,80}?(\d{1,3})\s*%/i
            ];
            for (const re of pats) { const m = html.match(re); if (m) { out.audience = m[1]; break; } }
        }
        if (!out.critic) {
            const pats = [
                /"criticsScore"\s*:\s*\{[^{}]*?"score"\s*:\s*"?(\d{1,3})/i,
                /"tomatometerScore"\s*:\s*\{[^{}]*?"score"\s*:\s*"?(\d{1,3})/i
            ];
            for (const re of pats) { const m = html.match(re); if (m) { out.critic = m[1]; break; } }
        }
        return out;
    }

    /* ---------------------------------------------------------------
     * Core fetch
     * ------------------------------------------------------------- */
    async function fetchRatings(movieTitle, year = null) {
        const cacheId = `${String(movieTitle).toLowerCase().trim()}|${year || ''}`;
        const hit = cacheGet(cacheId);
        if (hit) return Object.assign({ cached: true }, hit);

        const empty = {
            title: movieTitle, year: year || '', genre: 'Unknown',
            critic: 'N/A', audience: 'N/A', imdb: 'N/A', meta: 'N/A', rtUrl: null
        };

        try {
            let url = `https://www.omdbapi.com/?t=${encodeURIComponent(movieTitle)}` +
                      `&tomatoes=true&apikey=${encodeURIComponent(getKey())}`;
            if (year) url += `&y=${encodeURIComponent(year)}`;

            const res  = await gmFetch(url);
            const data = JSON.parse(res.responseText);

            if (data.Response === 'False') {
                const miss = Object.assign({}, empty, { error: data.Error || 'Not found' });
                cacheSet(cacheId, miss);
                return miss;
            }

            const ratings = Array.isArray(data.Ratings) ? data.Ratings : [];
            const find = (src) => ratings.find((r) => r.Source === src)?.Value;

            const out = {
                title:    data.Title || movieTitle,
                year:     data.Year || year || '',
                genre:    ok(data.Genre) ? data.Genre : 'Unknown',
                critic:   find('Rotten Tomatoes') || 'N/A',
                imdb:     ok(data.imdbRating) ? `${data.imdbRating}/10` : 'N/A',
                meta:     ok(data.Metascore) ? `${data.Metascore}/100` : 'N/A',
                audience: 'N/A',
                rtUrl:    ok(data.tomatoURL) ? data.tomatoURL : rtGuess(data.Title || movieTitle)
            };

            if (out.rtUrl) {
                try {
                    const rt = await gmFetch(out.rtUrl, {
                        headers: {
                            'User-Agent': navigator.userAgent,
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                        }
                    });
                    if (rt.status >= 200 && rt.status < 300) {
                        const s = extractScores(rt.responseText);
                        if (s.audience) out.audience = `${s.audience}%`;
                        if (s.critic && out.critic === 'N/A') out.critic = `${s.critic}%`;
                    }
                } catch (e) { /* RT is best-effort; OMDb data still stands */ }
            }

            cacheSet(cacheId, out);
            return out;
        } catch (e) {
            return Object.assign({}, empty, {
                critic: 'Error', audience: 'Error', error: e.message || String(e)
            });
        }
    }

    /* ---------------------------------------------------------------
     * Google: batch panel
     * ------------------------------------------------------------- */
    function initGoogleInterface() {
        const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = '+';
        toggleBtn.title = 'Movie ratings (Ctrl+Shift+M)';
        toggleBtn.style.cssText =
            'position:fixed;top:10px;left:50%;transform:translateX(-50%);width:40px;height:40px;' +
            'background:#4285f4;color:#fff;border:none;border-radius:50%;font-size:24px;cursor:pointer;' +
            'z-index:10000;box-shadow:0 2px 8px rgba(0,0,0,.2);transition:transform .2s;';
        toggleBtn.onmouseover = () => { toggleBtn.style.transform = 'translateX(-50%) scale(1.1)'; };
        toggleBtn.onmouseout  = () => { toggleBtn.style.transform = 'translateX(-50%) scale(1)'; };
        document.body.appendChild(toggleBtn);

        const panel = document.createElement('div');
        panel.style.cssText =
            'position:fixed;top:60px;left:50%;transform:translateX(-50%);width:520px;max-height:80vh;' +
            'overflow:auto;background:#fff;border-radius:8px;padding:20px;z-index:9999;' +
            `box-shadow:0 4px 20px rgba(0,0,0,.15);font-family:${FONT};display:none;`;
        panel.innerHTML = `
            <h3 style="margin:0 0 12px;color:#333;font-size:18px;">Movie Ratings (RT via OMDb)</h3>
            <textarea id="mrf-movies" placeholder="One title per line — 'Heat (1995)' pins the year"
                rows="5" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:8px;
                border:1px solid #ddd;border-radius:4px;font-size:14px;resize:vertical;font-family:inherit;"></textarea>
            <div style="display:flex;gap:8px;align-items:center;">
                <button id="mrf-fetch" style="flex:1;padding:10px;background:#4285f4;color:#fff;border:none;
                    border-radius:4px;font-size:14px;cursor:pointer;">Fetch Ratings</button>
                <select id="mrf-sort" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:13px;">
                    <option value="input">Input order</option>
                    <option value="critic">Critic ↓</option>
                    <option value="audience">Audience ↓</option>
                    <option value="title">Title A–Z</option>
                </select>
                <button id="mrf-copy" style="padding:10px;background:#f1f3f4;color:#333;border:1px solid #ddd;
                    border-radius:4px;font-size:13px;cursor:pointer;">Copy all</button>
            </div>
            <div id="mrf-status" style="margin-top:10px;color:#666;font-size:13px;"></div>
            <div id="mrf-results" style="margin-top:8px;"></div>
        `;
        document.body.appendChild(panel);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText =
            'position:absolute;top:10px;right:12px;background:none;border:none;font-size:24px;' +
            'color:#999;cursor:pointer;line-height:1;';
        closeBtn.onmouseover = () => { closeBtn.style.color = '#333'; };
        closeBtn.onmouseout  = () => { closeBtn.style.color = '#999'; };
        panel.appendChild(closeBtn);

        const $ = (id) => panel.querySelector(id);
        const ta        = $('#mrf-movies');
        const fetchBtn  = $('#mrf-fetch');
        const sortSel   = $('#mrf-sort');
        const copyBtn   = $('#mrf-copy');
        const statusDiv = $('#mrf-status');
        const resultsEl = $('#mrf-results');

        ta.value = GM_getValue('lastList', '');
        ta.addEventListener('input', () => GM_setValue('lastList', ta.value));

        const setOpen = (open) => {
            panel.style.display = open ? 'block' : 'none';
            toggleBtn.textContent = open ? '−' : '+';
            if (open) ta.focus();
        };
        toggleBtn.onclick = () => setOpen(panel.style.display === 'none');
        closeBtn.onclick  = () => setOpen(false);
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
                e.preventDefault(); setOpen(panel.style.display === 'none');
            }
            if (e.key === 'Escape' && panel.style.display === 'block') setOpen(false);
        });

        let results = [];

        function cardBg(r) {
            const b = best(r);
            if (b < 0)     return '#f8f9fa';
            if (b >= GOOD) return '#e6f4ea';
            if (b < BAD)   return '#fce8e6';
            return '#fef7e0';
        }

        function render() {
            const mode = sortSel.value;
            const rows = results.slice();
            if (mode === 'critic')        rows.sort((a, b) => scoreNum(b.critic) - scoreNum(a.critic));
            else if (mode === 'audience') rows.sort((a, b) => scoreNum(b.audience) - scoreNum(a.audience));
            else if (mode === 'title')    rows.sort((a, b) => a.title.localeCompare(b.title));

            resultsEl.innerHTML = rows.map((r) => {
                const t = tone(r);
                return `
                <div style="border-left:4px solid ${t.bd};padding:10px;margin:8px 0;
                            background:${cardBg(r)};border-radius:4px;
                            opacity:${t.dim === 0 ? 1 : t.dim < 1 ? 0.8 : 0.65};">
                    <strong style="color:#333;font-size:15px;">${esc(r.title)}</strong>
                    <span style="color:#999;font-size:12px;">${esc(r.year)}</span>
                    ${r.cached ? '<span style="color:#aaa;font-size:11px;"> · cached</span>' : ''}
                    <br>
                    <span style="color:#888;font-size:12px;">${esc(r.genre)}</span><br>
                    <span style="font-size:13px;">
                        <b style="color:${scoreColor(r.critic)};">🍅 ${esc(r.critic)}</b> &nbsp;
                        <b style="color:${scoreColor(r.audience)};">🍿 ${esc(r.audience)}</b> &nbsp;
                        <span style="color:#666;">IMDb ${esc(r.imdb)} · MC ${esc(r.meta)}</span>
                    </span>
                    ${r.error ? `<br><span style="color:#d93025;font-size:12px;">${esc(r.error)}</span>` : ''}
                </div>`;
            }).join('');
        }

        sortSel.onchange = render;

        copyBtn.onclick = async () => {
            if (!results.length) return;
            const tsv = ['Title\tYear\tGenre\tCritic\tAudience\tIMDb']
                .concat(results.map((r) => [r.title, r.year, r.genre, r.critic, r.audience, r.imdb].join('\t')))
                .join('\n');
            try {
                await navigator.clipboard.writeText(tsv);
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy all'; }, 1200);
            } catch (e) { console.error('Clipboard blocked:', e); }
        };

        fetchBtn.onmouseover = () => { fetchBtn.style.background = '#3367d6'; };
        fetchBtn.onmouseout  = () => { fetchBtn.style.background = '#4285f4'; };

        fetchBtn.onclick = async () => {
            const raw = ta.value.trim();
            if (!raw) { statusDiv.textContent = 'Enter at least one title.'; return; }

            const entries = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
                const m = line.match(/^(.*?)[\s(]*\b(19|20)(\d{2})\)?\s*$/);
                return m ? { title: m[1].trim(), year: `${m[2]}${m[3]}` } : { title: line, year: null };
            });

            fetchBtn.disabled = true;
            fetchBtn.style.opacity = '.6';
            results = [];
            let done = 0;
            statusDiv.textContent = `Fetching 0/${entries.length}…`;

            results = await mapPool(entries, CONCURRENCY, async (e) => {
                const r = await fetchRatings(e.title, e.year);
                done++;
                statusDiv.textContent = `Fetching ${done}/${entries.length}…`;
                return r;
            });

            statusDiv.textContent = `Done — ${entries.length} title(s).`;
            fetchBtn.disabled = false;
            fetchBtn.style.opacity = '1';
            render();
        };
    }

    /* ---------------------------------------------------------------
     * Tubi: badges load on view, minimizable, dim the weak ones
     * ------------------------------------------------------------- */
    function initTubiInterface() {
        const TILE = '[data-test-id="web-ui-content-tile"]';
        const DIM_ENABLED = GM_getValue('rtDim', true);

        const style = document.createElement('style');
        style.textContent = `
            .rt-badge{position:absolute;top:8px;right:8px;z-index:1000;color:#fff;font-size:11px;
                line-height:1.45;white-space:nowrap;border-radius:6px;padding:5px 8px;cursor:pointer;
                backdrop-filter:blur(4px);box-shadow:0 2px 8px rgba(0,0,0,.45);
                border:1px solid transparent;transition:background .15s,padding .1s;}
            .rt-badge.rt-min{padding:1px 4px;font-size:13px;background:transparent!important;
                border-color:transparent!important;box-shadow:none;opacity:.9;}
            .rt-badge.rt-muted{opacity:.42;filter:saturate(.4) brightness(.8);}
            .rt-badge .rt-genre{font-size:10px;color:#e0e0e0;margin-bottom:2px;max-width:150px;
                overflow:hidden;text-overflow:ellipsis;}
            .rt-badge .rt-line{font-weight:700;}
            .rt-badge .rt-year{font-size:10px;color:#cfcfcf;margin-bottom:2px;}
            .rt-min-btn{position:absolute;top:-7px;left:-7px;width:17px;height:17px;border-radius:50%;
                border:none;background:#1a1a1a;color:#fff;font-size:12px;line-height:17px;padding:0;
                cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.6);}
            .rt-spin{display:inline-block;animation:rtspin 1s linear infinite;}
            @keyframes rtspin{to{transform:rotate(360deg);}}
            .rt-dim{position:absolute;inset:0;z-index:999;cursor:pointer;border-radius:inherit;
                background:rgba(8,8,12,.62);backdrop-filter:grayscale(.75) saturate(.4);
                transition:opacity .18s ease;}
            .rt-dim.rt-dim-soft{background:rgba(8,8,12,.34);backdrop-filter:grayscale(.45);}
            .rt-dim::after{content:'click to view';position:absolute;bottom:6px;left:0;right:0;
                text-align:center;font-size:9px;letter-spacing:.04em;color:rgba(255,255,255,.55);}

            /* --- hide filters: purely CSS-driven, so tiles decorated later obey automatically --- */
            body.rt-hide-hard [data-rt-dim="hard"],
            body.rt-hide-soft [data-rt-dim="soft"]{display:none!important;}
            body.rt-hide-hero .rt-hero-root{display:none!important;}
            /* Tubi fades and disables the items it believes are half off the edge, via
               web-carousel__item--masked. It assigns that class from ITS OWN scroll
               index — which stopped matching reality the moment we took over the
               transform, so it lands on fully visible cards: washed out, no hover, no
               dismiss button, permanently. We decide what's visible now, so neutralise
               it. (Clipping still hides genuinely off-screen items; this only undoes
               the cosmetic fade and the pointer-events kill.) */
            .web-carousel__item--masked{opacity:1!important;pointer-events:auto!important;
                visibility:visible!important;filter:none!important;}
            .web-carousel__item--masked *{pointer-events:auto!important;}

            /* Gated by a body class so toggling is instant — no re-walk to restore. */
            body.rt-hide-dupes [data-rt-dupe="1"]{display:none!important;}

            /* Manual dismissals are not tied to any filter — always hidden. */
            [data-rt-dim="manual"]{display:none!important;}

            /* Tubi drops a poster overlay (play button + extra actions) on top of the
               poster on hover. It was covering the X, so the X never got :hover and the
               click went to the overlay. Sit above anything Tubi can stack. */
            .rt-tools{position:fixed;z-index:2147483000;display:flex;gap:5px;align-items:center;}

            .rt-x,.rt-yt{position:relative;width:26px;height:26px;
                border:none;border-radius:50%;padding:0;margin:0;line-height:26px;text-align:center;
                font-size:14px;font-weight:700;color:#fff;cursor:pointer;pointer-events:auto;
                /* Neutral dark scrim rather than dark red: a red button vanishes against
                   red/orange poster art. The white ring and shadow keep it legible on
                   any artwork, light or dark. */
                background:rgba(0,0,0,.55);backdrop-filter:blur(3px);
                box-shadow:0 0 0 1.5px rgba(255,255,255,.75),0 2px 6px rgba(0,0,0,.7);
                text-shadow:0 1px 2px rgba(0,0,0,.9);
                transition:opacity .12s ease,background .12s ease,transform .1s ease;}

            /* Invisible 46px target around each 26px circle — easy to hit on the way
               past, without buttons big enough to steal the poster's own click. */
            .rt-x::before,.rt-yt::before{content:'';position:absolute;inset:-10px;border-radius:50%;}

            .rt-yt{font-size:11px;line-height:26px;padding-left:2px;}
            .rt-yt:hover{opacity:1!important;background:#ff0033!important;
                box-shadow:0 0 0 2px #fff,0 2px 10px rgba(0,0,0,.8);transform:scale(1.18);}
            .rt-yt:active{transform:scale(.82);opacity:1;}

            /* They only exist while a card is hovered, so they can be bright from the
               moment they appear — no hunting for a near-invisible target. */
            .rt-x,.rt-yt{opacity:.85;}
            .rt-x:hover{opacity:1!important;background:#e01f1f!important;
                box-shadow:0 0 0 2px #fff,0 2px 10px rgba(0,0,0,.8);transform:scale(1.18);}
            /* Fires the instant the button is pressed — the confirmation can't lag. */
            .rt-x:active{transform:scale(.82);background:#ff2d2d!important;opacity:1;}
            .rt-x.rt-x-hit{opacity:1!important;background:#ff2d2d!important;
                animation:rtpop .18s ease-out;}
            @keyframes rtpop{0%{transform:scale(1);}45%{transform:scale(1.45);}100%{transform:scale(.6);}}

            /* Short on purpose: long enough to read as an action, short enough that
               dismissing several in a row never feels queued. */
            .rt-out{transition:opacity .16s ease,transform .16s ease!important;
                opacity:0!important;transform:scale(.85);pointer-events:none;}

            /* While a row is animating, its dismiss buttons go inert so a tile can't
               slide under the cursor and take the click meant for its neighbour. */
            /* (rows in motion hide the button outright — see showFloatXFor) */

            .rt-tgl.rt-undo.rt-flash{animation:rtflash .5s ease-out;}
            @keyframes rtflash{0%{background:#8a7a3a;transform:scale(1.12);}100%{background:#2f2a1a;transform:scale(1);}}
            .rt-bar{position:fixed;right:14px;bottom:14px;z-index:2147483001;display:flex;gap:6px;
                align-items:center;background:rgba(18,18,22,.93);border:1px solid #33333c;
                border-radius:10px;padding:6px;box-shadow:0 4px 16px rgba(0,0,0,.55);
                backdrop-filter:blur(6px);
                font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
            .rt-bar.rt-collapsed .rt-tgl{display:none;}
            .rt-tgl{background:#2a2a30;color:#dcdce2;border:1px solid #3a3a44;border-radius:7px;
                padding:6px 9px;cursor:pointer;font:inherit;white-space:nowrap;}
            .rt-tgl:hover{background:#35353f;}
            .rt-tgl.rt-on{background:#8a1f1f;border-color:#ff6b6b;color:#fff;}
            .rt-tgl.rt-all.rt-on{background:#1e8e3e;border-color:#3ddc6b;}
            .rt-n{opacity:.65;margin-left:5px;font-weight:400;}
            .rt-grip{background:none;border:none;color:#8b8b95;cursor:pointer;font:inherit;
                padding:5px 6px;line-height:1;}
            .rt-grip:hover{color:#fff;}
            .rt-prev{cursor:pointer;}
            .rt-arrow-off{opacity:.18!important;cursor:default!important;filter:grayscale(1);}
            .rt-arrow-off svg{opacity:.5!important;}
            .rt-tgl.rt-dupes.rt-on{background:#1b4d8f;border-color:#6ab0ff;color:#fff;}
            .rt-tgl.rt-undo{background:#2f2a1a;border-color:#8a7a3a;color:#f3e2a8;}
            .rt-tgl.rt-undo:hover{background:#40381f;}
        `;
        document.head.appendChild(style);

        /* ---- hide/show control bar ---------------------------------- */
        // Two dim levels map to two filter keys:
        //   soft = no score found (light veil)   hard = scored under 80 (full veil)
        const state = {
            soft: !!GM_getValue('rtHideSoft', false),
            hard: !!GM_getValue('rtHideHard', false),
            hero:  !!GM_getValue('rtHideHero', false),
            dupes: !!GM_getValue('rtHideDupes', false)
        };

        const bar = document.createElement('div');
        bar.className = 'rt-bar';
        bar.innerHTML = `
            <button class="rt-grip" title="Collapse / expand — shift-click to force a fill run (Ctrl+Shift+H toggles all)">👁</button>
            <button class="rt-tgl" data-k="hard" title="Hide titles scoring under 80">🔴🟡 Under 80<span class="rt-n" data-n="hard">0</span></button>
            <button class="rt-tgl" data-k="soft" title="Hide titles with no score">⚪ No score<span class="rt-n" data-n="soft">0</span></button>
            <button class="rt-tgl rt-all" data-k="all" title="Hide everything that is grayed out">Hide all gray</button>
            <button class="rt-tgl rt-dupes" data-k="dupes" title="Keep only the first listing of each film">⧉ Dupes<span class="rt-n" data-n="dupe">0</span></button>
            <button class="rt-tgl rt-hero" data-k="hero" title="Hide the whole hero carousel (Ctrl+Shift+K)">🎞 Carousel</button>
            <button class="rt-tgl rt-undo" data-k="undo" style="display:none">↶</button>
        `;
        document.body.appendChild(bar);

        const grip   = bar.querySelector('.rt-grip');
        const allBtn = bar.querySelector('.rt-tgl.rt-all');

        function applyState() {
            document.body.classList.toggle('rt-hide-soft', state.soft);
            document.body.classList.toggle('rt-hide-hard', state.hard);
            bar.querySelector('[data-k="hard"]').classList.toggle('rt-on', state.hard);
            bar.querySelector('[data-k="soft"]').classList.toggle('rt-on', state.soft);
            const allOn = state.soft && state.hard;
            allBtn.classList.toggle('rt-on', allOn);
            allBtn.textContent = allOn ? 'Show all gray' : 'Hide all gray';

            document.body.classList.toggle('rt-hide-dupes', state.dupes);
            const dupBtn = bar.querySelector('[data-k="dupes"]');
            if (dupBtn) dupBtn.classList.toggle('rt-on', state.dupes);
            if (state.dupes) sweepDupes();

            document.body.classList.toggle('rt-hide-hero', state.hero);
            const heroBtn = bar.querySelector('[data-k="hero"]');
            heroBtn.classList.toggle('rt-on', state.hero);
            heroBtn.textContent = state.hero ? '🎞 Carousel off' : '🎞 Carousel';

            // Filters changed — rows previously marked exhausted deserve another look.
            document.querySelectorAll('[data-rt-fill="done"]').forEach((n) => n.removeAttribute('data-rt-fill'));

            GM_setValue('rtHideSoft', state.soft);
            GM_setValue('rtHideHard', state.hard);
            GM_setValue('rtHideHero', state.hero);
            GM_setValue('rtHideDupes', state.dupes);
        }

        bar.addEventListener('click', (ev) => {
            const btn = ev.target.closest('.rt-tgl');
            if (btn) {
                ev.preventDefault(); ev.stopPropagation();
                const k = btn.dataset.k;
                if (k === 'undo') { undoDismiss(); return; }

                if (k === 'all') {
                    const on = !(state.soft && state.hard);
                    state.soft = on; state.hard = on;
                } else {
                    state[k] = !state[k];
                }
                applyState();
                return;
            }
            if (ev.target === grip) {
                ev.preventDefault(); ev.stopPropagation();
                // Shift-click the eye = force a fill run on every row in view, ignoring
                // the "does it need it" gate. Diagnostic escape hatch.
                if (ev.shiftKey) {
                    document.querySelectorAll(SHELL).forEach((shell, i) => {
                        if (!shell.dataset.rtRow) shell.dataset.rtRow = `row${i}`;
                        shell.removeAttribute('data-rt-fill');
                        const r = shell.getBoundingClientRect();
                        if (r.bottom > 0 && r.top < window.innerHeight) fillRow(shell, { anyOffset: true, always: true });
                    });
                    return;
                }
                bar.classList.toggle('rt-collapsed');
            }
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'h') {
                e.preventDefault();
                const on = !(state.soft && state.hard);
                state.soft = on; state.hard = on;
                applyState();
            }
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                undoDismiss();
            }
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                state.hero = !state.hero;
                applyState();
            }
        });

        /* ---- manual dismiss + undo -----------------------------------------
         * Dismissals live on the same slot attribute the filters use, under a
         * distinct "manual" value, so the collapse-the-gap behaviour is shared.
         * The stack keeps the last few so a mis-click is always recoverable.
         */
        const undoStack = [];
        const UNDO_MAX  = 10;

        // Tubi lists the same film in several rows. Dismissals are keyed on the film,
        // not the tile, so every copy goes — including ones not yet rendered, which
        // get caught by the sweep as they scroll in.
        const dismissedKeys = new Map();          // key -> title, for the session

        // The href carries a stable numeric id (/movies/602431/rush-hour-2). Prefer it
        // over the title, which varies in punctuation between listings.
        // Cached on the node: the sweep touches every tile on the page, and computing
        // this from the href each time is the difference between trivial and noticeable
        // once a few rows hold 200 items. resetTile() clears it on recycle.
        function keyOf(card) {
            return card.dataset.rtKey || (card.dataset.rtKey = movieKey(card));
        }

        function movieKey(card) {
            const href = card.querySelector('a.web-content-tile__title')?.getAttribute('href') || '';
            const m = href.match(/\/(\d+)\//);
            return m ? m[1] : (card.querySelector('a.web-content-tile__title')?.textContent.trim() ||
                               card.dataset.rtTitle || '').toLowerCase();
        }

        function eachCopy(key, fn) {
            if (!key) return;
            document.querySelectorAll(TILE).forEach((card) => {
                if (movieKey(card) === key) fn(card);
            });
        }

        /* ---- duplicate suppression -----------------------------------------
         * Keeps the first copy of each film in DOCUMENT order and marks the rest.
         * Recomputed from scratch every sweep rather than remembering a keeper: the
         * order of rows is stable and new tiles only ever append, so the same copy
         * stays the keeper — but if it gets recycled or dropped, the next copy is
         * promoted automatically instead of leaving the film hidden everywhere.
         *
         * Separate attribute from data-rt-dim on purpose. A film can be both a
         * duplicate and a 70%-scorer; one attribute can't hold both, and toggling a
         * rating filter would otherwise wipe the duplicate marking.
         */
        function sweepDupes() {
            const seen = new Set();
            document.querySelectorAll(TILE).forEach((card) => {
                const key = keyOf(card);
                if (!key) return;
                const slot = slotFor(card);
                if (!slot) return;
                if (seen.has(key)) slot.setAttribute('data-rt-dupe', '1');
                else { seen.add(key); slot.removeAttribute('data-rt-dupe'); }
            });
        }

        // Applies standing dismissals to anything newly on screen.
        function sweepDismissed() {
            if (!dismissedKeys.size) return;
            document.querySelectorAll(TILE).forEach((card) => {
                if (!dismissedKeys.has(movieKey(card))) return;
                const slot = slotFor(card);
                if (slot && slot.getAttribute('data-rt-dim') !== 'manual') {
                    slot.setAttribute('data-rt-dim', 'manual');
                }
            });
        }

        /* ---- floating dismiss button ---------------------------------------
         * One button, parented to <body>, moved to whichever tile is hovered.
         * A per-tile button is unwinnable: Tubi's hover zoom expands a tile past
         * its own bounds and elevates it as a whole stacking context, so the
         * NEIGHBOURING tile's overlay covers this tile's top-left corner — right
         * where the button sits. No z-index inside the tile can beat a sibling
         * that outranks its container. At body level nothing in a tile can cover
         * it, and it follows the genuinely-hovered card rather than fighting for
         * a fixed spot. Cheaper too: one node instead of one per tile.
         */
        const tools = document.createElement('div');
        tools.className = 'rt-tools';
        tools.style.display = 'none';

        const floatX = document.createElement('button');
        floatX.className = 'rt-x';
        floatX.textContent = '✕';
        floatX.title = 'Hide this title (Ctrl+Shift+Z to undo)';

        const floatYT = document.createElement('button');
        floatYT.className = 'rt-yt';
        floatYT.textContent = '▶';
        floatYT.title = 'Search YouTube for the trailer';

        tools.append(floatX, floatYT);
        document.body.appendChild(tools);

        let hoverCard = null;

        function hideFloatX() {
            hoverCard = null;
            tools.style.display = 'none';
        }

        function showFloatXFor(card) {
            const poster = card.querySelector('.web-content-tile__poster');
            if (!poster) return hideFloatX();
            const shell = card.closest(SHELL);
            if (shell && shell.dataset.rtScrolling === '1') return hideFloatX();  // row in motion
            const r = poster.getBoundingClientRect();
            if (r.width < 20 || r.bottom < 0 || r.top > window.innerHeight) return hideFloatX();
            hoverCard = card;
            tools.style.display = '';
            tools.style.left = `${Math.round(r.left + 6)}px`;
            tools.style.top  = `${Math.round(r.top + 6)}px`;
        }

        // Capture phase: whatever Tubi lays over the poster, the hovered element is
        // still a descendant of some tile, so closest() resolves the right card —
        // including the neighbour's expanded overlay, which is the honest answer for
        // "what is the mouse actually over".
        document.addEventListener('mouseover', (ev) => {
            if (tools.contains(ev.target)) return;            // keep state while on the buttons
            const card = ev.target.closest?.(TILE);
            if (card) showFloatXFor(card); else hideFloatX();
        }, true);

        floatX.addEventListener('click', (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            const card = hoverCard;
            if (!card) return;
            dismiss(card, card.dataset.rtTitle, floatX);
            hideFloatX();
        }, true);

        floatYT.addEventListener('click', (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            const card = hoverCard;
            if (!card) return;
            // Read live rather than from our records: a recycled node may be showing a
            // different film than the one we last decorated.
            const title = card.querySelector('a.web-content-tile__title')?.textContent.trim()
                       || card.dataset.rtTitle || '';
            const year  = card.querySelector('.web-content-tile__year')?.textContent.trim() || '';
            if (!title) return;
            const q = `${title} ${year} trailer`.replace(/\s+/g, ' ').trim();
            window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
                        '_blank', 'noopener,noreferrer');
            floatYT.classList.add('rt-x-hit');
            setTimeout(() => floatYT.classList.remove('rt-x-hit'), 200);
        }, true);

        window.addEventListener('scroll', hideFloatX, { passive: true });

        // Strip a tile back to undecorated. Cancels any in-flight rating for it, so a
        // pass that is mid-await can't come back and dress the new occupant.
        function resetTile(card) {
            card.__rtToken = (card.__rtToken || 0) + 1;
            card.querySelectorAll('.rt-badge, .rt-dim').forEach((n) => n.remove());
            const slot = slotFor(card);
            if (slot) {
                slot.removeAttribute('data-rt-dim');
                slot.classList.remove('rt-out');
                // A dismissal applied to whatever used to live here; it says nothing
                // about the new title, so drop it from the undo history too.
                for (let i = undoStack.length - 1; i >= 0; i--) {
                    if (undoStack[i].slot === slot) undoStack.splice(i, 1);
                }
                refreshUndo();
            }
            const poster = card.querySelector('.web-content-tile__poster');
            if (poster) poster.style.boxShadow = '';
            delete card.dataset.rtKey;
            card.dataset.rtDone = '';
        }

        // Tubi recycles tile nodes in place — near the end of a row especially, new
        // content lands in a node we already decorated. Nothing re-triggers decorate()
        // for it (it's marked done and the observer released it long ago), so it keeps
        // the previous film's badge, veil and slot state forever. Catch the mismatch by
        // comparing the tile's own title text against what we last recorded.
        function repairStaleTitles() {
            document.querySelectorAll(`${TILE}[data-rt-done="1"]`).forEach((card) => {
                const now = card.querySelector('a.web-content-tile__title')?.textContent.trim();
                if (!now || now === card.dataset.rtTitle) return;
                log('recycled node:', card.dataset.rtTitle, '->', now);
                resetTile(card);
                decorate(card);
                // ...unless the film that just landed here is itself dismissed.
                if (dismissedKeys.has(movieKey(card))) slotFor(card)?.setAttribute('data-rt-dim', 'manual');
            });
        }

        // Safety net for the same class of bug: a veil can only be legitimate when its
        // slot is actually marked soft/hard. Anything else is a leftover from a recycled
        // node, so strip it and restore the tile to its rated appearance.
        function repairVeils() {
            document.querySelectorAll('.rt-dim').forEach((veil) => {
                const card = veil.closest(TILE);
                if (!card) return;
                const lvl = slotFor(card)?.getAttribute('data-rt-dim');
                if (lvl === 'soft' || lvl === 'hard' || lvl === 'manual') return;
                // Redraw rather than patch: the veil is one symptom of a tile wearing
                // another film's verdict, and the rating is cached so this is cheap.
                log('stale veil on', card.dataset.rtTitle, '— redrawing');
                resetTile(card);
                decorate(card);
            });
        }

        const OUT_MS = 170;                        // must match the .rt-out transition

        function dismiss(card, title, btn) {
            const slot = slotFor(card);
            if (!slot || slot.classList.contains('rt-out')) return;   // already on its way out

            // Feedback first, before any of the bookkeeping — the click must read as
            // registered even if a fill kicks off right behind it.
            if (btn) {
                btn.classList.add('rt-x-hit');
                setTimeout(() => btn.classList.remove('rt-x-hit'), 200);
            }
            slot.classList.add('rt-out');

            const key = movieKey(card);
            dismissedKeys.set(key, title || card.dataset.rtTitle || 'title');
            undoStack.push({ slot, key, prev: slot.getAttribute('data-rt-dim'), title: title || 'title' });
            if (undoStack.length > UNDO_MAX) undoStack.shift();
            refreshUndo(true);

            setTimeout(() => {
                slot.setAttribute('data-rt-dim', 'manual');
                slot.classList.remove('rt-out');
                sweepDismissed();                  // the other copies, wherever they are
                if (state.dupes) sweepDupes();     // and re-pick keepers around the gap
                refreshCounts();
                const shell = slot.closest(SHELL);
                if (shell) {
                    clampRow(shell);                          // close the gap behind it
                    fillRow(shell, { anyOffset: true });      // and top the row up now,
                }                                             // not on the next 2.5s scan
            }, OUT_MS);
        }

        function undoDismiss() {
            const last = undoStack.pop();
            if (!last) return;
            dismissedKeys.delete(last.key);

            // Every copy comes back, each redrawn from its own cached rating rather than
            // assuming they all shared the state of the one that was clicked.
            eachCopy(last.key, (card) => {
                const slot = slotFor(card);
                if (slot?.getAttribute('data-rt-dim') !== 'manual') return;
                resetTile(card);
                decorate(card);
            });

            last.slot.classList.remove('rt-out');
            if (last.prev === null) last.slot.removeAttribute('data-rt-dim');
            else last.slot.setAttribute('data-rt-dim', last.prev);

            refreshUndo();
            refreshCounts();
            last.slot.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        }

        function refreshUndo(flash) {
            const btn = bar.querySelector('[data-k="undo"]');
            if (!btn) return;
            if (flash) {
                btn.classList.remove('rt-flash');
                void btn.offsetWidth;                  // restart the animation
                btn.classList.add('rt-flash');
            }
            const last = undoStack[undoStack.length - 1];
            btn.style.display = last ? '' : 'none';
            if (last) {
                const name = last.title.length > 22 ? `${last.title.slice(0, 21)}…` : last.title;
                btn.textContent = `↶ ${name}`;
                btn.title = `Un-hide "${last.title}" everywhere on the page (Ctrl+Shift+Z)`;
            }
        }

        let countT;
        function refreshCounts() {
            clearTimeout(countT);
            countT = setTimeout(() => {
                let soft = 0, hard = 0;
                document.querySelectorAll('[data-rt-dim]').forEach((n) => {
                    const v = n.dataset.rtDim;
                    if (v === 'soft') soft++;
                    else if (v === 'hard') hard++;      // 'manual' counts toward neither
                });
                bar.querySelector('[data-n="hard"]').textContent = hard;
                bar.querySelector('[data-n="soft"]').textContent = soft;
                const dupeN = bar.querySelector('[data-n="dupe"]');
                if (dupeN) dupeN.textContent = document.querySelectorAll('[data-rt-dupe="1"]').length;
            }, 250);
        }

        applyState();

        /* ------------------------------------------------------------- */

        // Some hero slides use title artwork instead of an <h2>, so fall back to the img alt.
        function cardTitle(el) {
            const h = el.querySelector('h2');
            if (h && h.textContent.trim()) return h.textContent.trim();
            const alt = el.querySelector('img[alt]')?.getAttribute('alt')?.trim();
            if (alt && alt.length > 1 && !/^(play|poster|thumbnail|logo|image)$/i.test(alt)) return alt;
            return null;
        }

        // Hero/carousel cards have hashed class names, so key off structure instead:
        // start from the play button and walk up until an ancestor yields a title.
        function heroCards() {
            const out = new Set();
            document.querySelectorAll('.web-play-button').forEach((btn) => {
                if (btn.closest(TILE)) return;
                let el = btn.parentElement;
                for (let i = 0; i < 6 && el; i++) {
                    if (cardTitle(el)) { out.add(el); return; }
                    el = el.parentElement;
                }
            });
            return [...out];
        }

        const allCards = () => [...document.querySelectorAll(TILE), ...heroCards()];

        // Tubi wraps each tile in one or more per-item <div>s that carry the row's
        // fixed column width. Hiding the tile alone leaves that wrapper holding the
        // gap open, so climb to the outermost wrapper that still contains exactly
        // this one tile and hide that instead — the row then closes up.
        // Always resolve the slot fresh. A cached reference goes stale when React
        // re-parents a tile, and if the old node happens to be dimmed, every check
        // that relies on it silently reads the wrong answer.
        function slotFor(card) {
            return card.closest('[data-rt-dim]') || slotOf(card);
        }

        function slotOf(tile) {
            const vw = window.innerWidth || document.documentElement.clientWidth;
            let el = tile;
            for (let i = 0; i < 5; i++) {
                const p = el.parentElement;
                if (!p || p === document.body) break;
                if (p.querySelectorAll(TILE).length !== 1) break;      // reached the row track
                const pw = p.getBoundingClientRect().width;
                const ew = el.getBoundingClientRect().width || 1;
                if (pw >= vw * 0.9 || pw > ew * 1.6) break;            // row container, not a slot
                el = p;
            }
            return el;
        }

        // Find the carousel's outer container by climbing from a hero card until the
        // ancestor spans the viewport. Bail out the moment an ancestor also contains
        // grid tiles — that means we've climbed past the carousel into the page body.
        function heroRoot(seeds) {
            seeds = seeds || heroCards();
            if (!seeds.length) return null;
            const vw = window.innerWidth || document.documentElement.clientWidth;
            let el = seeds[0], safe = null;
            while (el && el !== document.body) {
                if (el.querySelector(TILE)) break;
                safe = el;
                if (el.getBoundingClientRect().width >= vw * 0.9 &&
                    seeds.every((s) => el.contains(s))) break;
                el = el.parentElement;
            }
            return safe;
        }

        function markHeroRoot(seeds) {
            const root = heroRoot(seeds);
            document.querySelectorAll('.rt-hero-root').forEach((n) => {
                if (n !== root) n.classList.remove('rt-hero-root');
            });
            if (root) root.classList.add('rt-hero-root');
        }

        function readCard(el) {
            if (el.matches(TILE)) {
                return {
                    title:  el.querySelector('a.web-content-tile__title')?.textContent.trim(),
                    year:   el.querySelector('.web-content-tile__year')?.textContent.match(/\b(19|20)\d{2}\b/)?.[0] || null,
                    genre:  el.querySelector('.web-content-tile__tags')?.textContent.trim() || 'Unknown',
                    anchor: el.querySelector('.web-content-tile__poster')
                };
            }
            const raw = el.innerText || el.textContent || '';
            const m = raw.match(/([A-Za-z&'’\- ]+?)\s*·\s*((?:19|20)\d{2})/);
            return {
                title:  cardTitle(el),
                year:   m ? m[2] : null,
                genre:  m ? m[1].trim() : 'Unknown',
                anchor: el
            };
        }

        // Year on its own line between the genres and the scores — it costs no extra
        // width, which the genre line has none of to spare. Prefer the tile's own year
        // over OMDb's, which can differ on re-releases.
        function body(genre, r, year) {
            const y = year || r.year || '';
            return `<div class="rt-genre">${esc(genre)}</div>` +
                   (y ? `<div class="rt-year">${esc(y)}</div>` : '') +
                   `<div class="rt-line">🍅 ${esc(r.critic)}</div>` +
                   `<div class="rt-line">🍿 ${esc(r.audience)}</div>`;
        }

        async function decorate(card) {
            if (!card) return;
            const current = card.matches(TILE)
                ? card.querySelector('a.web-content-tile__title')?.textContent.trim()
                : cardTitle(card);
            if (card.dataset.rtDone === '1') {
                if (!current || card.dataset.rtTitle === current) return;
                card.querySelectorAll('.rt-badge, .rt-dim').forEach((n) => n.remove());
                slotFor(card)?.removeAttribute('data-rt-dim');   // stale level from the recycled tile
                card.dataset.rtDone = '';
            }
            const { title, year, genre, anchor } = readCard(card);
            if (!title || !anchor) return;
            card.dataset.rtDone = '1';
            card.dataset.rtTitle = title;
            anchor.style.boxShadow = '';

            if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';

            const badge = document.createElement('div');
            badge.className = 'rt-badge';
            badge.innerHTML = '<span class="rt-spin">⏳</span>';
            anchor.appendChild(badge);

            // Tubi recycles tile nodes. If this one is repurposed while the rating is
            // in flight, the continuation below would paint the OLD title's verdict onto
            // the NEW title — a green film wearing a red veil. Claim the node before
            // awaiting and bail out afterwards if someone else has claimed it since.
            const token = (card.__rtToken = (card.__rtToken || 0) + 1);

            let r;
            try { r = await fetchRatings(title, year); }
            catch (e) { r = { critic: 'Error', audience: 'Error' }; }

            if (card.__rtToken !== token || !card.isConnected || card.dataset.rtTitle !== title) {
                badge.remove();
                return log('stale decoration dropped:', title);
            }

            // Whatever this node wore previously is no longer valid.
            anchor.querySelectorAll('.rt-dim').forEach((n) => n.remove());

            const t = tone(r);
            let minimized = false;

            // Tag the tile with its dim level so the CSS filters above pick it up the moment
            // it's decorated — including tiles that scroll in while a filter is already on.
            // Hero slides are skipped: collapsing one breaks the carousel's layout.
            if (card.matches(TILE) && dismissedKeys.has(movieKey(card))) {
                badge.remove();                // dismissed elsewhere; nothing to dress
                slotFor(card)?.setAttribute('data-rt-dim', 'manual');
                return;
            }

            if (card.matches(TILE)) {
                const slot = slotOf(card);
                card.__rtSlot = slot;
                if (t.dim === 0) slot.removeAttribute('data-rt-dim');
                else slot.setAttribute('data-rt-dim', t.dim < 1 ? 'soft' : 'hard');
                refreshCounts();
            }

            // Winners get a thin green outline; everything else gets a click-to-clear veil.
            if (t.dim === 0) {
                if (!anchor.style.borderRadius) anchor.style.borderRadius = '6px';
                anchor.style.boxShadow = 'inset 0 0 0 2px #3ddc6b, 0 0 10px rgba(61,220,107,.35)';
            } else if (DIM_ENABLED) {
                badge.classList.add('rt-muted');
                const veil = document.createElement('div');
                veil.className = 'rt-dim' + (t.dim < 1 ? ' rt-dim-soft' : '');
                veil.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    badge.classList.remove('rt-muted');
                    slotFor(card)?.removeAttribute('data-rt-dim');   // manually cleared — keep it visible
                    refreshCounts();
                    veil.style.opacity = '0';
                    veil.style.pointerEvents = 'none';
                    setTimeout(() => veil.remove(), 200);
                }, true);
                anchor.appendChild(veil);
            }

            const paint = () => {
                badge.classList.toggle('rt-min', minimized);
                if (minimized) {
                    badge.innerHTML = t.dot;
                } else {
                    badge.style.background  = t.bg;
                    badge.style.borderColor = t.bd;
                    badge.innerHTML = body(genre, r, year);
                }
                const btn = document.createElement('button');
                btn.className = 'rt-min-btn';
                btn.textContent = minimized ? '+' : '−';
                btn.title = minimized ? 'Show ratings' : 'Minimize';
                btn.addEventListener('click', (ev) => {
                    ev.preventDefault(); ev.stopPropagation();
                    minimized = !minimized; paint();
                }, true);
                badge.appendChild(btn);
            };
            paint();

            badge.addEventListener('click', async (ev) => {
                if (ev.target.closest('.rt-min-btn')) return;   // let the minimize button handle it
                ev.preventDefault(); ev.stopPropagation();
                if (minimized) { minimized = false; paint(); return; }
                const text = `${title}${year ? ` (${year})` : ''} | ${genre} | ` +
                             `Critic: ${r.critic} | Audience: ${r.audience}`;
                try {
                    await navigator.clipboard.writeText(text);
                    badge.innerHTML = '<div class="rt-line">✓ Copied!</div>';
                    setTimeout(paint, 1000);
                } catch (err) {
                    badge.innerHTML = '<div class="rt-line">⚠ Copy failed</div>';
                    setTimeout(paint, 1500);
                }
            }, true);
        }

        const io = new IntersectionObserver((entries) => {
            entries.forEach((en) => {
                if (en.isIntersecting) { io.unobserve(en.target); decorate(en.target); }
            });
        }, { rootMargin: '150px 0px' });

        const observe = (el) => {
            if (el.dataset.rtDone !== '1' && !el.dataset.rtSeen) {
                el.dataset.rtSeen = '1';
                io.observe(el);
            }
        };

        // Hero slides sit off-screen horizontally, so IO never fires for them — decorate directly.
        /* ---- auto-fill: pull the next page into rows that end in blank space ----
         * Each row is its own transform-based carousel. Once hidden tiles collapse,
         * the first page can run short. Tubi only appends more tiles when you page
         * forward, so: click next (loads the next batch), rate the new tiles, then
         * click previous to park the row back at the start with the extra tiles in
         * the DOM. Repeat until the row fills or Tubi stops handing over more.
         */
        const SHELL      = '.web-carousel-shell';
        const TRACK      = '[data-test-id="web-ui-grid-container"]';
        const ITEM       = '[data-test-id="web-ui-grid-item"]';
        const MAX_PAGES  = 12;    // ~120 items; the feed caps at 200 anyway
        const BACK_WAIT  = 220;   // per step walking Tubi's index home (masked by the pin)
        const BUFFER       = 1.8; // viewports of content to keep loaded past the edge
        const MAX_DECORATE = 60;  // tiles rated per fill round
        const GAP_MIN    = 40;    // px of trailing blank (logging only; the gate is enoughVisible)

        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        // Tubi's own arrows only — never our injected .rt-prev.
        function arrow(shell, dir) {
            const icon = dir === 'next' ? 'right' : 'left';
            return shell.querySelector(`.web-carousel-shell__${dir}:not(.rt-prev)`) ||
                   shell.querySelector(`[data-test-id="icons-chevron-circle-${icon}"]`)
                        ?.closest('div:not(.rt-prev)');
        }

        function trailingGap(shell) {
            const track = shell.querySelector(TRACK);
            const cont  = shell.querySelector('.web-carousel__container') || track?.parentElement;
            if (!track || !cont) return 0;
            const last = lastVisible(track);
            if (!last) return 0;
            return cont.getBoundingClientRect().right - last.getBoundingClientRect().right;
        }

        // Only top rows up while they're parked at the start — never yank a row
        // out from under someone who's scrolling it by hand.
        function atStart(shell) {
            const track = shell.querySelector(TRACK);
            const m = /translate3d\(\s*(-?[\d.]+)px/.exec(track?.style.transform || '');
            return !m || Math.abs(parseFloat(m[1])) < 4;
        }

        async function decorateRow(track) {
            const tiles = [...track.querySelectorAll(`${TILE}:not([data-rt-done="1"])`)]
                .slice(0, MAX_DECORATE);
            if (!tiles.length) return;
            tiles.forEach((t) => { t.dataset.rtSeen = '1'; });   // keep IO from re-queuing them
            await mapPool(tiles, CONCURRENCY, decorate);
        }

        // display:none leaves offsetParent null, which is the cheapest visibility test
        // available. These walk to the first/last hit instead of materialising an array
        // of up to 200 items on every scan.
        const visibleItems = (track) =>
            [...track.querySelectorAll(ITEM)].filter((el) => el.offsetParent !== null);

        function firstVisible(track) {
            for (const el of track.querySelectorAll(ITEM)) if (el.offsetParent) return el;
            return null;
        }

        function lastVisible(track) {
            const items = track.querySelectorAll(ITEM);
            for (let i = items.length - 1; i >= 0; i--) if (items[i].offsetParent) return items[i];
            return null;
        }

        /* ---- scroll hijack ------------------------------------------------
         * Tubi always translates by exactly one viewport (5 tiles) per click,
         * derived from its own item index — it has no idea half the row is
         * display:none. So paging forward eventually lands on pure blank.
         * We swallow arrow clicks in the capture phase (React delegates at the
         * root, so stopping it here means React never sees it and never
         * re-renders the transform) and drive translate3d ourselves, clamped
         * to where the surviving tiles actually end.
         */
        let programmatic = false;        // set while fillRow drives Tubi's own arrows

        function metrics(shell) {
            const track = shell.querySelector(TRACK);
            const cont  = shell.querySelector('.web-carousel__container') || track?.parentElement;
            if (!track || !cont) return null;
            const W    = cont.getBoundingClientRect().width;
            const last = lastVisible(track);
            const first = firstVisible(track);
            if (!last || !first) return { W, contentW: 0, tileW: 0, max: 0 };
            // track's rect already includes the current translate, so measuring the
            // last tile against it yields untranslated content width.
            const trackLeft = track.getBoundingClientRect().left;
            const contentW  = last.getBoundingClientRect().right - trackLeft;
            const tileW     = first.getBoundingClientRect().width || 1;
            const step      = Math.max(tileW, Math.floor(W / tileW) * tileW) || W;
            // Stops are page-aligned. The final stop is the first page boundary that
            // reveals the tail — so the last page keeps whatever blank space it has,
            // rather than sliding back to sit flush against the right edge. That gap
            // is the clearest signal that the row is finished.
            const max = Math.ceil(Math.max(0, contentW - W) / step) * step;
            return { W, contentW, tileW, step, max };
        }

        const offsetOf = (shell) => parseFloat(shell.dataset.rtOff || '0') || 0;

        // The track animates for 0.6s; flag the row so its dismiss buttons can't be
        // hit while tiles are sliding under the cursor.
        function markScrolling(shell, ms = 650) {
            shell.dataset.rtScrolling = '1';
            clearTimeout(shell.__rtScrollT);
            shell.__rtScrollT = setTimeout(() => { delete shell.dataset.rtScrolling; }, ms);
        }

        function applyOffset(shell, off) {
            hideFloatX();                    // the card under the cursor is about to move
            const track = shell.querySelector(TRACK);
            if (!track) return;
            off = Math.max(0, off);
            const moved = Math.abs(off - offsetOf(shell)) > 1;
            track.style.transform = `translate3d(${-off}px, 0px, 0px)`;
            shell.dataset.rtOff = String(off);
            if (moved) markScrolling(shell);
            updateArrows(shell);
        }

        // Tubi only renders its previous arrow once its own index advances — which
        // never happens now that we swallow the clicks. So we supply one, reusing
        // Tubi's class for positioning and a mirrored clone of its chevron.
        function ownPrev(shell) {
            let p = shell.querySelector('.rt-prev');
            if (p) return p;
            const next = arrow(shell, 'next');
            if (!next) return null;
            p = document.createElement('div');
            p.className = 'web-carousel-shell__previous rt-prev';
            const svg = next.querySelector('svg');
            if (svg) {
                const clone = svg.cloneNode(true);
                clone.style.transform = 'rotate(180deg)';
                p.appendChild(clone);
            }
            p.style.display = 'none';
            shell.insertBefore(p, shell.firstChild);
            return p;
        }

        function updateArrows(shell) {
            const m = metrics(shell);
            if (!m) return;
            const off  = offsetOf(shell);
            const prev = ownPrev(shell);
            if (prev) prev.style.display = off > 1 ? '' : 'none';
            // Tubi's index is left advanced after a fill, so it may render its own
            // previous arrow. Suppress it; ours is the one bound to our offset.
            const tubiPrev = arrow(shell, 'previous');
            if (tubiPrev) tubiPrev.style.display = 'none';
            // On the last page with nothing further to fetch, leave the arrow in place
            // but visibly dead — a greyed-out control says "end of row" more clearly
            // than one that silently vanishes.
            const next = arrow(shell, 'next');
            if (next) {
                const ended = off >= m.max - 1 && shell.dataset.rtFill === 'done';
                next.classList.toggle('rt-arrow-off', ended);
                next.style.pointerEvents = ended ? 'none' : '';
            }
        }

        async function onArrowClick(ev) {
            const shell = ev.currentTarget;
            const isNext = !!ev.target.closest('.web-carousel-shell__next');
            const isPrev = !!ev.target.closest('.rt-prev, .web-carousel-shell__previous');
            if (!isNext && !isPrev) return;
            if (programmatic) return;              // our own fillRow clicks pass through
            ev.preventDefault();
            ev.stopPropagation();

            const m = metrics(shell);
            if (!m) return;
            const off  = offsetOf(shell);
            const step = m.step;

            if (isPrev) { applyOffset(shell, Math.max(0, off - step)); return; }

            // Already at the end of the surviving content — pull more in before moving.
            if (off >= m.max - 1) {
                log(shell.dataset.rtRow || '?', 'at content end — fetching more');
                await fillRow(shell, { anyOffset: true, always: true });
                const m2 = metrics(shell);
                if (m2) applyOffset(shell, Math.min(off + step, m2.max));
                return;
            }
            applyOffset(shell, Math.min(off + step, m.max));
        }

        // Backstop for the case above: React re-renders for reasons of its own (hover,
        // new items, route changes) and rewrites the track's inline transform. Watch the
        // style attribute and put our offset straight back.
        function guardTransform(shell) {
            if (shell.__rtGuard) return;
            const track = shell.querySelector(TRACK);
            if (!track) return;
            const mo = new MutationObserver(() => {
                if (shell.dataset.rtFill === 'busy') return;     // the pin loop owns it mid-fill
                const want = `translate3d(${-offsetOf(shell)}px, 0px, 0px)`;
                if (track.style.transform !== want) track.style.transform = want;
            });
            mo.observe(track, { attributes: true, attributeFilter: ['style'] });
            shell.__rtGuard = mo;
        }

        function hijack(shell) {
            if (shell.dataset.rtHijack === '1') return;
            shell.dataset.rtHijack = '1';
            shell.addEventListener('click', onArrowClick, true);   // capture, before React
            guardTransform(shell);
            updateArrows(shell);
        }

        // Ratings arrive after the row is laid out, so content shrinks under us.
        // Pull the offset back in whenever it would now expose blank space.
        function clampRow(shell) {
            // At offset 0 there is nothing to pull back, and arrow state only changes
            // when the feed is exhausted — skip the layout reads in the common case.
            if (offsetOf(shell) === 0 && shell.dataset.rtFill !== 'done') return;
            const m = metrics(shell);
            if (!m) return;
            const off = offsetOf(shell);
            if (off > m.max) applyOffset(shell, m.max);
            else updateArrows(shell);
        }

        // Everything still showing packs to the left once the hidden slots collapse,
        // so "enough" is simply: enough surviving tiles to span the viewport, plus one.
        function enoughVisible(shell) {
            const track = shell.querySelector(TRACK);
            const cont  = shell.querySelector('.web-carousel__container') || track?.parentElement;
            if (!track || !cont) return true;
            const first = firstVisible(track);
            if (!first) return false;
            const w    = first.getBoundingClientRect().width || 1;
            // Hold a buffer past the right edge rather than exactly one screenful, so
            // dismissing a few titles doesn't instantly expose blank while the next
            // page is still loading.
            const need = Math.ceil(cont.getBoundingClientRect().width * BUFFER / w) + 1;
            let n = 0;
            for (const el of track.querySelectorAll(ITEM)) {
                if (el.offsetParent && ++n >= need) return true;   // early exit
            }
            return false;
        }

        // opts.anyOffset — top up even when the row is scrolled in (a dismissal can
        //   shorten a row you're already partway through).
        // opts.always    — page forward even if the row currently looks full.
        async function fillRow(shell, opts = {}) {
            const { anyOffset = false, always = false } = opts === true ? { anyOffset: true, always: true } : opts;
            const tag = shell.dataset.rtRow || '?';
            if (shell.dataset.rtFill && !always) return log(tag, 'skip: state =', shell.dataset.rtFill);
            const track = shell.querySelector(TRACK);
            if (!track)                          return log(tag, 'skip: no track');
            if (!arrow(shell, 'next'))           return log(tag, 'skip: no next arrow');
            if (!anyOffset && !atStart(shell))   return log(tag, 'skip: not parked at start —', track.style.transform);
            // The honest test isn't "is there a visible gap" but "can the surviving
            // tiles span the viewport at all". Same thing at rest, but it survives
            // the case where the last DOM item still overflows to the right.
            if (!always && enoughVisible(shell)) return log(tag, 'skip: row already spans the viewport');

            shell.dataset.rtFill = 'busy';
            if (DEBUG) log(tag, 'FILL START — items', track.querySelectorAll(ITEM).length,
                     'visible', visibleItems(track).length, 'gap', Math.round(trailingGap(shell)));

            // Tubi's paging translates the whole row a full screen and we'd then have to
            // walk it back — a visible round trip for what should be a one-tile reflow.
            // Since we own the transform now, just pin it every frame: React advances its
            // own index and fetches the next batch, while the row never appears to move.
            // The appended tiles land off-screen right and the reflow does the rest.
            const pinAt = offsetOf(shell);
            let pinning = true;
            const pin = () => {
                if (!pinning) return;
                track.style.transform = `translate3d(${-pinAt}px, 0px, 0px)`;
                requestAnimationFrame(pin);
            };
            pin();

            try {
                // React destroys and rebuilds the arrow div on every page, so a cached
                // reference is detached from the second click onward. Re-query each time.
                let pages = 0;
                for (let i = 0; i < MAX_PAGES; i++) {
                    const next = arrow(shell, 'next');
                    if (!next) { shell.dataset.rtFill = 'done'; log(tag, 'end of feed at page', i); break; }
                    programmatic = true; next.click(); programmatic = false;
                    pages++;
                    await sleep(FWD_WAIT);                       // appended items land ~1s later
                    await decorateRow(track);                    // rate them before judging the count
                    if (DEBUG) log(tag, 'page', pages, '— items', track.querySelectorAll(ITEM).length,
                             'visible', visibleItems(track).length);
                    if (enoughVisible(shell)) { log(tag, 'enough after', pages, 'pages'); break; }
                }
                // Walk Tubi's index back to 0. This is NOT cosmetic: leaving it advanced
                // means its next re-render applies translate3d(-1085 x index) and throws
                // the row off-screen. The pin above keeps the walk invisible.
                // Its own transform is masked by the pin, so position can't be read from
                // it — the previous arrow's existence is the signal instead (Tubi removes
                // it at index 0).
                for (let i = 0; i < pages + 3; i++) {
                    const prev = arrow(shell, 'previous');
                    if (!prev) break;
                    programmatic = true; prev.click(); programmatic = false;
                    await sleep(BACK_WAIT);
                }
                log(tag, 'index home?', !arrow(shell, 'previous'));
            } catch (e) {
                log(tag, 'ERROR', e);
            } finally {
                pinning = false;
                if (shell.dataset.rtFill === 'busy') delete shell.dataset.rtFill;
                programmatic = false;
                applyOffset(shell, Math.min(offsetOf(shell), metrics(shell)?.max ?? 0));
            }
        }

        const DEBUG = !!GM_getValue('rtDebug', false);
        const log = (...a) => { if (DEBUG) console.log('[MRF]', ...a); };

        let offLogged = false;
        function maybeFill() {
            if (!(state.soft || state.hard)) {
                if (!offLogged) {
                    offLogged = true;
                    log('maybeFill off — no hide filter active');
                }
                return;
            }
            offLogged = false;
            const shells = [...document.querySelectorAll(SHELL)];
            log('maybeFill — shells on page:', shells.length);
            shells.forEach((shell, i) => {
                if (!shell.dataset.rtRow) shell.dataset.rtRow = `row${i}`;
                const r = shell.getBoundingClientRect();
                if (r.bottom > 0 && r.top < window.innerHeight) {
                    hijack(shell);      // take over the arrows
                    clampRow(shell);    // never leave blank space exposed
                    fillRow(shell);
                }
            });
        }

        const scan = () => {
            if (document.hidden) return;                       // nothing to do in a background tab
            // ':not([data-rt-seen])' filters natively — far cheaper than iterating
            // every tile on the page and testing in JS.
            document.querySelectorAll(`${TILE}:not([data-rt-seen])`).forEach(observe);
            const heroes = heroCards();          // one walk, used by both steps below
            markHeroRoot(heroes);
            // No point burning API calls on slides nobody can see.
            if (!state.hero) heroes.forEach(decorate);
            refreshCounts();
            if (!bar.isConnected) document.body.appendChild(bar);   // survive route changes
            repairStaleTitles();
            repairVeils();
            sweepDismissed();
            if (state.dupes) sweepDupes();
            maybeFill();
        };

        let scanT;
        const queueScan = () => { clearTimeout(scanT); scanT = setTimeout(scan, 300); };

        // Scope the observer to the app's content root where possible — watching all of
        // <body> means React's constant churn allocates mutation records we never use.
        const moTarget = document.querySelector('main') || document.body;
        new MutationObserver(queueScan).observe(moTarget, { childList: true, subtree: true });

        // The poll exists because the hero carousel swaps slides without mutating much.
        // It backs off in a hidden tab and resumes on focus.
        setInterval(scan, 2500);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) queueScan(); });
        scan();
    }

    /* ------------------------------------------------------------- */
    if (window.location.hostname.includes('tubi')) initTubiInterface();
    else initGoogleInterface();
})();