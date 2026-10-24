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
  net (balance change) and gross (everything collected) for each currency, next to the game's own figure, which is
  gross per *simulated* second over 3 minutes. Also shows how much of real time the game simulated and how much it
  dropped (a tick waiting longer than 0.1 s visible / 5 s hidden throws the rest away), and logs every drop over
  0.2 s plus a summary each minute.

## Security note

The debug port listens on 127.0.0.1 only, uses a new random port each launch, and rejects connections from web pages
(no `--remote-allow-origins`). Other programs running as you on this PC could still connect while the game runs.
