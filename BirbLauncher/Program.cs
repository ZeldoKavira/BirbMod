using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace BirbMod
{
    // Starts Birb with WebView2 remote debugging on a private local port, finds the game object in its page, and
    // injects the mods from the mods folder. Then stays running until the game exits: re-injects after a page reload,
    // hot-reloads a mod when its file changes, and writes the mods' log to %LOCALAPPDATA%\BirbMod\birbmod.log.
    //
    // Steam launch option: "<path>\BirbLauncher.exe" %command%   (Steam passes the game's own command line).
    // Started while Birb is already running through this launcher, it re-attaches instead (port kept in session.json).
    internal static class Program
    {
        private static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BirbMod");
        private static readonly string LogPath = Path.Combine(DataDir, "birbmod.log");
        private static readonly string SessionPath = Path.Combine(DataDir, "session.json");
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        private static string _modsDir;
        private static readonly ConcurrentDictionary<string, DateTime> ChangedMods = new ConcurrentDictionary<string, DateTime>();

        private static int Main(string[] args)
        {
            Console.Title = "Birb mod launcher";
            Directory.CreateDirectory(DataDir);
            try
            {
                return Run(args).GetAwaiter().GetResult();
            }
            catch (Exception e)
            {
                Say($"Launcher failed: {e}");
                Thread.Sleep(8000);
                return 1;
            }
        }

        private static async Task<int> Run(string[] args)
        {
            // --check-update: only check for (and install) an update, then exit - the game isn't started or touched.
            if (args.Contains("--check-update"))
            {
                Updater.UpdateAndRestart(args);
                return 0;
            }
            // Installed copies update themselves before starting the game (never while it's running through them).
            if (Process.GetProcessesByName("birb").Length == 0 && Updater.UpdateAndRestart(args))
                return 0;

            _modsDir = FindModsDir();
            Say($"Mods folder: {_modsDir}");

            var (process, port) = StartOrAttach(args);
            if (process == null)
                return 2;

            Remote.Start(DataDir);

            var target = await WaitForPage(port, process);
            if (target == null)
            {
                Say("The game's page never showed up on the debug port; mods not loaded.");
                return 3;
            }

            using (var watcher = WatchMods())
            {
                while (!process.HasExited)
                {
                    try
                    {
                        using (var cdp = await Cdp.ConnectAsync(target))
                        {
                            Say("Connected to the game.");
                            Remote.SetCdp(cdp);
                            await Serve(cdp, process);
                        }
                    }
                    catch (Exception e) when (!process.HasExited)
                    {
                        Say($"Lost the game connection ({e.Message}); retrying.");
                    }
                    if (!process.HasExited)
                    {
                        await Task.Delay(2000);
                        target = await WaitForPage(port, process) ?? target;
                    }
                }
            }
            Say("Birb closed.");
            TryDelete(SessionPath);
            return 0;
        }

        // ---- starting the game ----

        private static (Process, int) StartOrAttach(string[] args)
        {
            var running = Process.GetProcessesByName("birb");
            if (running.Length > 0)
            {
                var session = ReadSession();
                var match = session != null ? running.FirstOrDefault(p => p.Id == session.Value.pid) : null;
                if (match != null && PortAnswers(session.Value.port))
                {
                    Say($"Birb is already running with the mod port open; attaching (port {session.Value.port}).");
                    return (match, session.Value.port);
                }
                Say("Birb is already running without the mod loader. Close it, then start it through this launcher.");
                Thread.Sleep(10000);
                return (null, 0);
            }

            var exe = args.Length > 0 ? args[0] : GameLocator.Find();
            if (!File.Exists(exe))
            {
                Say($"Can't find the game at {exe}");
                Thread.Sleep(10000);
                return (null, 0);
            }
            var port = FreePort();
            var psi = new ProcessStartInfo(exe, string.Join(" ", args.Skip(1).Select(Quote)))
            {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(exe),
            };
            // Local-only debug endpoint on a fresh port each launch; any browser arguments already set are kept.
            var extra = Environment.GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
            psi.EnvironmentVariables["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] =
                ((extra ?? "") + $" --remote-debugging-port={port}").Trim();
            var process = Process.Start(psi);
            File.WriteAllText(SessionPath, Json.Serialize(new Dictionary<string, object> { ["pid"] = process.Id, ["port"] = port }));
            Say($"Started Birb (pid {process.Id}), debug port {port} on 127.0.0.1.");
            return (process, port);
        }

        private static string Quote(string a) => a.Contains(' ') && !a.StartsWith("\"") ? $"\"{a}\"" : a;

        private static int FreePort()
        {
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            var port = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return port;
        }

        private static (int pid, int port)? ReadSession()
        {
            try
            {
                var d = Json.DeserializeObject(File.ReadAllText(SessionPath)) as Dictionary<string, object>;
                return d == null ? ((int, int)?)null : (Convert.ToInt32(d["pid"]), Convert.ToInt32(d["port"]));
            }
            catch
            {
                return null;
            }
        }

        private static bool PortAnswers(int port)
        {
            try { return Targets(port) != null; }
            catch { return false; }
        }

        private static object[] Targets(int port)
        {
            using (var wc = new WebClient())
                return Json.DeserializeObject(wc.DownloadString($"http://127.0.0.1:{port}/json")) as object[];
        }

        private static async Task<string> WaitForPage(int port, Process process)
        {
            for (var i = 0; i < 180 && !process.HasExited; i++)
            {
                try
                {
                    var page = Targets(port)?.OfType<Dictionary<string, object>>()
                        .FirstOrDefault(t => (string)t["type"] == "page" && ((string)t["url"]).StartsWith("http://tauri.localhost"));
                    if (page != null)
                        return (string)page["webSocketDebuggerUrl"];
                }
                catch { /* not up yet */ }
                await Task.Delay(500);
            }
            return null;
        }

        // ---- serving the page ----

        private static async Task Serve(Cdp cdp, Process process)
        {
            var nextLogDrain = DateTime.UtcNow;
            var loaded = false; // mods (re)loaded from disk on this connection: a re-attach picks up edits made meanwhile
            while (!process.HasExited && cdp.IsOpen)
            {
                if (!await CoreReady(cdp))
                {
                    loaded = false;
                    if (!await InstallCore(cdp))
                    {
                        await Task.Delay(2000); // the game is still loading its save
                        continue;
                    }
                }
                if (!loaded)
                {
                    var v = Updater.Current;
                    await cdp.Eval($"window.BirbMod.launcherVersion = 'v{v.Major}.{v.Minor}.{Math.Max(0, v.Build)}'");
                    await LoadAllMods(cdp);
                    loaded = true;
                }

                foreach (var pair in ChangedMods.ToArray())
                {
                    if (DateTime.UtcNow - pair.Value < TimeSpan.FromMilliseconds(400))
                        continue; // editors write files in bursts
                    ChangedMods.TryRemove(pair.Key, out _);
                    var path = Path.Combine(_modsDir, pair.Key + ".js");
                    if (File.Exists(path))
                        await LoadMod(cdp, path);
                    else
                    {
                        await cdp.Eval($"BirbMod.unload({Json.Serialize(pair.Key)})");
                        Say($"Unloaded {pair.Key} (file removed).");
                    }
                }

                if (DateTime.UtcNow >= nextLogDrain)
                {
                    nextLogDrain = DateTime.UtcNow.AddSeconds(3);
                    await DrainLog(cdp);
                }
                await Task.Delay(250);
            }
            try { await DrainLog(cdp); } catch { /* closing */ }
        }

        // Installed and the same version as the core in this launcher (an older one gets replaced).
        private static async Task<bool> CoreReady(Cdp cdp)
        {
            var v = await cdp.Eval("window.BirbMod && window.BirbMod.coreVersion || 0");
            return Convert.ToInt32(v ?? 0) == CoreVersion;
        }

        private static int CoreVersion
        {
            get
            {
                var m = System.Text.RegularExpressions.Regex.Match(ReadCore(), @"CORE_VERSION\s*=\s*(\d+)");
                return m.Success ? int.Parse(m.Groups[1].Value) : 1;
            }
        }

        // The game object isn't global; its document visibilitychange listener closes over it. Walk that listener's
        // closure scopes for the object that has the game's state, hand it to the page, and install the core.
        private static async Task<bool> InstallCore(Cdp cdp)
        {
            // An older core already holds the game: hand that over instead of searching again.
            if (await cdp.Eval("!!(window.BirbMod && window.BirbMod.game)") is bool has && has)
            {
                await cdp.Eval("window.__birbGameHandoff = window.BirbMod.game, true"); // don't return the game object itself
                Say($"Mod core {await cdp.Eval(ReadCore() + "\n//# sourceURL=birbmod/core.js")} (upgraded).");
                return true;
            }
            var listeners = await cdp.EvalHandle(
                "(getEventListeners(document).visibilitychange || []).map(l => l.listener)", commandLineApi: true);
            if (listeners == null)
                return false;
            string gameId = null;
            foreach (var fn in (await cdp.Properties(listeners, own: true)).Where(p => p.Key.All(char.IsDigit) && p.Value != null))
            {
                var fnId = fn.Value.TryGetValue("objectId", out var id) ? (string)id : null;
                if (fnId == null)
                    continue;
                var scopes = (await cdp.Properties(fnId, own: false)).FirstOrDefault(p => p.Key == "[[Scopes]]").Value;
                if (scopes == null || !scopes.TryGetValue("objectId", out var scopesId))
                    continue;
                foreach (var scope in await cdp.Properties((string)scopesId, own: true))
                {
                    if (scope.Value == null || !scope.Value.TryGetValue("objectId", out var scopeId))
                        continue;
                    foreach (var variable in await cdp.Properties((string)scopeId, own: true))
                    {
                        var v = variable.Value;
                        if (v == null || !Equals(v.TryGetValue("type", out var t) ? t : null, "object") || !v.TryGetValue("objectId", out var objId))
                            continue;
                        var isGame = await cdp.CallOn((string)objId,
                            "function(){ return !!(this && this.currencyRates && this.state && this.state.resources && typeof this.logicLoop === 'function'); }");
                        if (isGame is bool b && b)
                        {
                            gameId = (string)objId;
                            break;
                        }
                    }
                    if (gameId != null) break;
                }
                if (gameId != null) break;
            }
            if (gameId == null)
                return false;

            await cdp.CallOn(gameId, "function(){ window.__birbGameHandoff = this; }");
            var result = await cdp.Eval(ReadCore() + "\n//# sourceURL=birbmod/core.js");
            Say($"Mod core {result}.");
            return true;
        }

        private static string ReadCore()
        {
            using (var s = typeof(Program).Assembly.GetManifestResourceStream("BirbMod.core.js"))
            using (var r = new StreamReader(s, Encoding.UTF8))
                return r.ReadToEnd();
        }

        private static async Task LoadAllMods(Cdp cdp)
        {
            foreach (var path in Directory.GetFiles(_modsDir, "*.js").OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
                await LoadMod(cdp, path);
            ChangedMods.Clear();
        }

        private static async Task LoadMod(Cdp cdp, string path)
        {
            var name = Path.GetFileNameWithoutExtension(path);
            string source;
            try { source = ReadShared(path); }
            catch (IOException e)
            {
                Say($"Couldn't read {name}: {e.Message}");
                ChangedMods[name] = DateTime.UtcNow; // try again shortly
                return;
            }
            // The mod's first line is line 1 of the wrapper's second line, so page errors point at the right line.
            var expr = $"BirbMod.run({Json.Serialize(name)}, function(mod, game) {{\n{source}\n}})\n//# sourceURL=birbmod/{name}.js";
            try
            {
                await cdp.Eval(expr);
                Say($"Loaded {name}.");
            }
            catch (CdpException e)
            {
                Say($"{name} failed to load: {e.Message}");
            }
            await DrainLog(cdp);
        }

        private static string ReadShared(string path)
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var r = new StreamReader(fs, Encoding.UTF8))
                return r.ReadToEnd();
        }

        private static async Task DrainLog(Cdp cdp)
        {
            if (!(await cdp.Eval("window.BirbMod ? BirbMod.drainLog() : []") is object[] lines) || lines.Length == 0)
                return;
            var text = string.Join(Environment.NewLine, lines.Select(l => l?.ToString())) + Environment.NewLine;
            File.AppendAllText(LogPath, text);
            foreach (var line in lines)
                Console.WriteLine("  " + line);
        }

        // ---- hot reload ----

        private static FileSystemWatcher WatchMods()
        {
            var w = new FileSystemWatcher(_modsDir, "*.js") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size };
            // The "*.js" filter also matches editors' temp files such as meter.js.tmp.1234; only real .js files count.
            void Mark(string name)
            {
                if (name != null && name.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
                    ChangedMods[Path.GetFileNameWithoutExtension(name)] = DateTime.UtcNow;
            }
            FileSystemEventHandler changed = (s, e) => Mark(e.Name);
            w.Changed += changed;
            w.Created += changed;
            w.Deleted += changed;
            w.Renamed += (s, e) =>
            {
                Mark(e.OldName);
                Mark(e.Name);
            };
            w.EnableRaisingEvents = true;
            return w;
        }

        // A "mods" folder next to the launcher, or in a folder above it (so a dev build finds the repo's mods).
        private static string FindModsDir()
        {
            var dir = AppDomain.CurrentDomain.BaseDirectory;
            for (var i = 0; i < 5 && dir != null; i++)
            {
                var candidate = Path.Combine(dir, "mods");
                if (Directory.Exists(candidate))
                    return candidate;
                dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar));
            }
            var fallback = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "mods");
            Directory.CreateDirectory(fallback);
            return fallback;
        }

        internal static void Say(string text)
        {
            var line = $"{DateTime.Now:HH:mm:ss} {text}";
            Console.WriteLine(line);
            try { File.AppendAllText(LogPath, $"{DateTime.Now:O} launcher: {text}{Environment.NewLine}"); } catch { }
        }

        private static void TryDelete(string path)
        {
            try { File.Delete(path); } catch { }
        }
    }
}
