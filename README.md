# School Games

Old educational computer games from the 80s and early 90s, rebuilt as mobile web apps.

Play: https://djessemann.github.io/school-games/

The home page is a portal. Each game lives in its own folder.

| Game | Folder |
| --- | --- |
| Planetary Construction Set | `planets/` |
| Word Munchers (MECC, 1985) | `munchers/` |
| Odell Lake (MECC, 1986) | `odell/` |
| Where in the World Is Carmen Sandiego? (Broderbund, 1985) | `carmen/` |

On iPhone: open the link in Safari, tap Share, then **Add to Home Screen**. It runs full screen and works offline after the first load.

## The Apple II disk games

Word Munchers, Odell Lake and Carmen Sandiego run their original Apple II disks on a small emulator written for this site, in `shared/`:
`cpu6502.js` is the processor, `apple2.js` is the rest of the machine (memory, disk drive, keyboard, speaker, screen),
and `disk-game.js` / `disk-game.css` are the page around it (screen, controller, sound, saving high scores, name entry).
It uses no Apple ROMs; the few built-in routines the games call are rewritten in `apple2.js`.
It can be an Apple II+ (48K) or an Apple IIe with 128K, has two disk drives, and starts ProDOS disks by loading the
PRODOS file itself (a ProDOS boot block would otherwise copy code out of the disk card's ROM).

Each game page lays out its own controller and tells `disk-game.js` what the big button should do. It decides by
where the game is reading the keyboard, which says what the game is waiting for. High scores are saved in the browser,
and a text box appears for the phone keyboard when a game asks for a name.

**Word Munchers:** arrows, the big button (Space while playing and on "Press SPACE BAR" screens, Return on the menu and
Yes/No prompts), Pause (?) and Quit (Escape twice). The "play with a joystick?" question is patched out when the disk loads.

**Carmen Sandiego:** a 128K IIe game on two disk sides, both in the drives at once. Arrows move the highlight, OK is
Return, Back is Escape. For (Y/N) questions the arrows make way for Yes and No, and the name prompt gets the name box.
The disks are 4am's clean cracks of the original.

**Odell Lake:** arrows and OK (Return) on menus; during an encounter the arrows make way for the five choices
(Shallow escape on top, Eat / Chase / Ignore, Deep escape below). Help (?) and Back (Escape).

## Adding a game

1. Put the game in its own folder with an `index.html` and `icons/icon-192.png`.
2. Add it to the `GAMES` list in the root `index.html`.
3. Add its files to `FILES` in `sw.js` and bump `CACHE` so phones pick up the change.
4. For an Apple II disk game, copy `odell/index.html` as a start: set the disk, the controller and the keyboard readers.
5. In the game, link the shared manifest (`../manifest.webmanifest`) and register the worker with `navigator.serviceWorker.register('../sw.js', { scope: '../' })`.
