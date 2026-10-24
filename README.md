# BirbMod

Mods for **Birb** (Steam). Birb is a Tauri app: the whole game is a web page running in WebView2, so mods are
JavaScript injected into that page. `BirbLauncher.exe` starts the game with WebView2 remote debugging on a private
local port, finds the game object, and loads every `.js` file in `mods/`.

## Use

Build once (needs the .NET SDK):

```
dotnet build -c Release BirbLauncher
```

Then either run `BirbLauncher\bin\Release\BirbLauncher.exe`, or keep launching from Steam by setting Birb's launch
options (Steam > Birb > Properties > Launch options) to:

```
"C:\Users\bruta\Documents\Dev\BirbMod\BirbLauncher\bin\Release\BirbLauncher.exe" %command%
```

The launcher window stays open while the game runs; closing the game closes it. The mods' log is written to
`%LOCALAPPDATA%\BirbMod\birbmod.log`.

## Play from your phone

The launcher also serves the game live to a phone browser: it prints a link like
`http://<pc-address>:8766/?t=<token>` when it starts (port and token in `%LOCALAPPDATA%\BirbMod
emote.json`;
delete that file for a new token). Open it on a phone on the same network:

- one finger taps and drags (the game gets a mouse), two fingers scroll
- the bar has Tab, Esc, Space, Meter (F9) and Speed (F10)
- frames come from the page's own screencast and only run while a phone is watching (about 7 per second)

Allow the launcher through Windows Firewall when asked. Away from home, use something like Tailscale on the PC and phone
rather than opening the port on your router: the page is plain HTTP, protected only by the token.

## Hot reload

- Save a file in `mods/` and it's unloaded and reloaded in the running game within about half a second.
  Deleting a file unloads it.
- Closing and restarting the launcher while the game runs re-attaches (port kept in `%LOCALAPPDATA%\BirbMod\session.json`)
  and reloads all mods from disk. Only a game that was started some other way needs restarting.

## Writing a mod

A mod file is the body of `function(mod, game) { ... }`:

- `game` is the game object (`game.state`, `game.currencyRates`, `game.logicLoop`, ...).
- `mod.onUnload(fn)` registers cleanup; undo everything the mod changed there (restore wrapped functions, remove DOM,
  clear timers and listeners) so a reload leaves no trace.
- `mod.log(text)` writes a line to `birbmod.log`.

`window.BirbMod` (the core) has `run(name, factory)`, `unload(name)`, `list()` and `game`.

## Mods

- **meter.js** - real-time income meter (F9 shows/hides it, drag it by its title). Per real second over the last 60 s:
  net (balance change) and gross (everything collected) for each currency, next to the game's own figure (gross per
  *simulated* second over 3 minutes, converted to per real second so it accounts for game speed). Also shows how much
  of the time that should have been simulated (real time x game speed) was, and how much the game
  dropped (a tick waiting longer than 0.1 s visible / 5 s hidden throws the rest away), and logs every drop over
  0.2 s plus a summary each minute.

- **payback.js** - adds "~Xs payback" under the cost on the Popcorn tab's buy buttons (Popcorn Value, Faster Popcorns,
  Popcorn Cap, Wing Training): the upgrade's cost divided by the extra popcorn per second it should bring, at your
  popcorn income over the last 60 real seconds. Value scales every pickup; spawn speed only helps while the meadow isn't
  full, wing speed and cap only while it is (the share of time it's full is measured). While MAX is hovered (the game
  previews the whole purchase on the buy button), the label shows that purchase's payback, marked (max).

- **autobuy.js** - an "Auto-buy" panel with two toggles (off until ticked, remembered between launches):
  *Popcorn upgrades, payback < 1 min* buys the popcorn upgrade with the quickest payback (payback.js's estimate) while
  it's under 60 s and affordable, re-checking after each level; *Seed upgrades* buys every level your seeds cover of each
  upgrade the game rates as free to buy, which is the seed-cost upgrades once Nature's Subsidy ("Upgrades don't spend
  seeds") is owned. Purchases go through the game's own upgrade manager.

- **speed.js** - game speed control (F10 shows/hides it, drag it by its title): -/+ and 0.5x-10x presets, through the
  game's own `debugGameSpeedMultiplier`, which it clamps to 0.25x-10x. Remembered between launches; unloading the mod
  puts 1x back. Wall-clock timers (offline earnings, cultivation) don't speed up, and progress made faster still counts
  toward the stats the game reports to its leaderboards.

## Security note

The debug port listens on 127.0.0.1 only, uses a new random port each launch, and rejects connections from web pages
(no `--remote-allow-origins`). Other programs running as you on this PC could still connect while the game runs.
