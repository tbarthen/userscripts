// ==UserScript==
// @name         Google Sheets Header Toggle
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  Hide the Google Sheets title bar, menu bar and toolbar, and give the space to the grid
// @match        https://docs.google.com/spreadsheets/*
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    // Everything above the grid is three sibling rows inside #docs-chrome:
    //   #docs-header-container   title, star, share      ~32px
    //   #docs-menubar            File Edit View ...      ~33px
    //   #docs-toolbar-wrapper    the icon toolbar        ~40px
    //
    // Hiding them is easy. Getting the grid to USE the space is the trick:
    // the grid is a canvas Sheets sizes itself, and it only re-lays out when
    // its viewport monitor sees the viewport change size. That monitor reads
    // document.documentElement.clientHeight and does nothing if the value
    // matches the last one it saw — so a synthetic resize event, on its own,
    // is ignored.
    //
    // The fix is to make that one read return a different number. Shadowing
    // clientHeight on the root element instance with a getter that returns
    // (real + 1), firing resize, then deleting the shadow and firing resize
    // again gives the monitor two genuine changes to react to. The second
    // pass lands on the true height, with the chrome already out of the
    // layout, so the editor and canvas grow to fill the window exactly.
    //
    // The same nudge on expand makes Sheets re-measure its menus and toolbar
    // while they are visible, which is what keeps them from coming back in
    // compact mode.

    const TARGETS = [
        '#docs-header-container',
        '#docs-menubar',
        '#docs-toolbar-wrapper'
    ];

    GM_addStyle(`
        #gs-header-toggle {
            position: fixed;
            top: 4px;
            left: 4px;
            z-index: 99999;
            background: #333;
            color: white;
            border: none;
            border-radius: 0 0 6px 6px;
            padding: 2px 12px 4px;
            cursor: pointer;
            font-size: 14px;
            opacity: 0.25;
            transition: opacity 0.2s;
        }
        #gs-header-toggle:hover { opacity: 1; }
        #gs-header-toggle.expanded { border-radius: 6px; }

        body.gs-chrome-hidden ${TARGETS.join(',\n        body.gs-chrome-hidden ')} {
            display: none !important;
        }
    `);

    // Two resize events with a different measured height in between. The
    // shadow lives on the element instance, not the prototype, and is
    // deleted before the second event, so nothing else ever sees it.
    function relayout() {
        const root = document.documentElement;
        const real = root.clientHeight;
        Object.defineProperty(root, 'clientHeight', {
            configurable: true,
            get: () => real + 1
        });
        window.dispatchEvent(new Event('resize'));
        setTimeout(() => {
            delete root.clientHeight;
            window.dispatchEvent(new Event('resize'));
        }, 250);
    }

    function init() {
        const toolbar = document.querySelector('#docs-toolbar-wrapper');
        if (!toolbar || toolbar.getBoundingClientRect().height === 0) {
            setTimeout(init, 500);
            return;
        }

        const btn = document.createElement('button');
        btn.id = 'gs-header-toggle';
        btn.textContent = '▼';
        btn.title = 'Show/hide the title bar, menus and toolbar';
        document.body.appendChild(btn);

        // Let Sheets finish measuring itself before taking the rows away.
        setTimeout(() => setHidden(true), 1200);

        btn.addEventListener('click', () => {
            setHidden(!document.body.classList.contains('gs-chrome-hidden'));
        });

        function setHidden(hidden) {
            document.body.classList.toggle('gs-chrome-hidden', hidden);
            btn.textContent = hidden ? '▲' : '▼';
            btn.classList.toggle('expanded', hidden);
            relayout();
        }
    }

    init();
})();
