# School Games

Old educational computer games from the 80s and early 90s, rebuilt as mobile web apps.

Play: https://djessemann.github.io/school-games/

The home page is a portal. Each game lives in its own folder.

| Game | Folder |
| --- | --- |
| Planetary Construction Set | `planets/` |
| Word Munchers (MECC, 1985) | `munchers/` |

On iPhone: open the link in Safari, tap Share, then **Add to Home Screen**. It runs full screen and works offline after the first load.

## Word Munchers

This one runs the original Apple II disk (`munchers/munchers.dsk`) on a small emulator written for this site:
`cpu6502.js` is the processor, `apple2.js` is the rest of the machine (memory, disk drive, keyboard, speaker, screen).
It uses no Apple ROMs; the few built-in routines the game calls are rewritten in `apple2.js`.
The on-screen controller sends the same keys the game expects: arrows, Space (Munch), ? (Pause), Escape twice (Quit), Return (OK).
Hall of Fame scores are saved in the browser.

## Adding a game

1. Put the game in its own folder with an `index.html` and `icons/icon-192.png`.
2. Add it to the `GAMES` list in the root `index.html`.
3. Add its files to `FILES` in `sw.js` and bump `CACHE` so phones pick up the change.
4. In the game, link the shared manifest (`../manifest.webmanifest`) and register the worker with `navigator.serviceWorker.register('../sw.js', { scope: '../' })`.
