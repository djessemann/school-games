# School Games

Old educational computer games from the 80s and early 90s, rebuilt as mobile web apps.

Play: https://djessemann.github.io/school-games/

The home page is a portal. Each game lives in its own folder.

| Game | Folder |
| --- | --- |
| Planetary Construction Set | `planets/` |

On iPhone: open the link in Safari, tap Share, then **Add to Home Screen**. It runs full screen and works offline after the first load.

## Adding a game

1. Put the game in its own folder with an `index.html` and `icons/icon-192.png`.
2. Add it to the `GAMES` list in the root `index.html`.
3. Add its files to `FILES` in `sw.js` and bump `CACHE` so phones pick up the change.
4. In the game, link the shared manifest (`../manifest.webmanifest`) and register the worker with `navigator.serviceWorker.register('../sw.js', { scope: '../' })`.
