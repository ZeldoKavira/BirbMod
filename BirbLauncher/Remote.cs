using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace BirbMod
{
    // Play from a phone: a small web server on the local network (port 8766 unless remote.json says otherwise) that
    // shows the game page live and sends taps back as mouse input. Frames come from the page's own screencast, which
    // only runs while someone is watching; input goes in through the DevTools Input domain, so it works whatever window
    // has focus. Every request but the page itself needs the token from remote.json (the link the launcher prints).
    //
    //   GET  /                  the phone page
    //   GET  /frame?after=N     the next frame after N (waits up to 2 s): JPEG, X-Frame-Id, X-Css-W / X-Css-H
    //   POST /input             {type: down|move|up|wheel|key, x, y (0..1 of the frame), dy, key}
    internal static class Remote
    {
        private const int DefaultPort = 8766;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        private static TcpListener _listener;
        private static string _token;
        private static int _port;
        private static string _page;

        private static volatile Cdp _cdp;
        private static Cdp _castingOn;
        private static readonly object FrameLock = new object();
        private static byte[] _frame;
        private static long _frameId;
        private static double _cssW = 1, _cssH = 1;
        private static DateTime _lastViewer = DateTime.MinValue;
        private static bool _pressed;

        internal static void Start(string dataDir)
        {
            LoadConfig(Path.Combine(dataDir, "remote.json"));
            using (var s = typeof(Remote).Assembly.GetManifestResourceStream("BirbMod.remote.html"))
            using (var r = new StreamReader(s, Encoding.UTF8))
                _page = r.ReadToEnd();
            try
            {
                _listener = new TcpListener(IPAddress.Any, _port);
                _listener.Start();
            }
            catch (Exception e)
            {
                Log($"Remote play unavailable: couldn't listen on port {_port} ({e.Message}).");
                return;
            }
            new Thread(AcceptLoop) { IsBackground = true, Name = "remote" }.Start();
            new Thread(IdleLoop) { IsBackground = true, Name = "remote-idle" }.Start();
            Log("Remote play: open one of these on your phone (same Wi-Fi, or Tailscale):");
            foreach (var url in Urls())
                Log("  " + url);
        }

        private static void LoadConfig(string path)
        {
            Dictionary<string, object> cfg = null;
            try { cfg = Json.DeserializeObject(File.ReadAllText(path)) as Dictionary<string, object>; } catch { /* first run */ }
            _port = cfg != null && cfg.TryGetValue("port", out var p) ? Convert.ToInt32(p) : DefaultPort;
            _token = cfg != null && cfg.TryGetValue("token", out var t) && t is string ts && ts.Length >= 16 ? ts : NewToken();
            File.WriteAllText(path, Json.Serialize(new Dictionary<string, object> { ["port"] = _port, ["token"] = _token }));
        }

        private static string NewToken()
        {
            var bytes = new byte[16];
            using (var rng = RandomNumberGenerator.Create())
                rng.GetBytes(bytes);
            return string.Concat(bytes.Select(b => b.ToString("x2")));
        }

        internal static IEnumerable<string> Urls()
        {
            IPAddress[] addresses;
            try { addresses = Dns.GetHostEntry(Dns.GetHostName()).AddressList; }
            catch { addresses = new IPAddress[0]; }
            var lan = addresses.Where(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a)).ToList();
            if (lan.Count == 0)
                lan.Add(IPAddress.Loopback);
            return lan.Select(a => $"http://{a}:{_port}/?t={_token}");
        }

        // The game connection the launcher currently has (it changes on reconnect / page reload).
        internal static void SetCdp(Cdp cdp)
        {
            if (_listener == null || cdp == null)
                return;
            _cdp = cdp;
            cdp.Event += (method, args) =>
            {
                if (method == "Page.screencastFrame" && args != null)
                    OnFrame(cdp, args);
            };
        }

        private static void OnFrame(Cdp cdp, Dictionary<string, object> args)
        {
            // Acknowledge first, off the reader thread, or the page stops sending frames.
            var session = args.TryGetValue("sessionId", out var sid) ? sid : null;
            Task.Run(() => cdp.Call("Page.screencastFrameAck", new Dictionary<string, object> { ["sessionId"] = session }));
            if (!(args.TryGetValue("data", out var data) && data is string b64))
                return;
            var bytes = Convert.FromBase64String(b64);
            lock (FrameLock)
            {
                if (args.TryGetValue("metadata", out var m) && m is Dictionary<string, object> meta)
                {
                    if (meta.TryGetValue("deviceWidth", out var w)) _cssW = Math.Max(1, Convert.ToDouble(w));
                    if (meta.TryGetValue("deviceHeight", out var h)) _cssH = Math.Max(1, Convert.ToDouble(h));
                }
                _frame = bytes;
                _frameId++;
                Monitor.PulseAll(FrameLock);
            }
        }

        private static async Task EnsureCasting()
        {
            var cdp = _cdp;
            if (cdp == null || !cdp.IsOpen || _castingOn == cdp)
                return;
            _castingOn = cdp;
            try
            {
                await cdp.Call("Page.startScreencast", new Dictionary<string, object>
                {
                    ["format"] = "jpeg", ["quality"] = 60, ["maxWidth"] = 1600, ["maxHeight"] = 1000, ["everyNthFrame"] = 3,
                });
                Log("Remote play: a phone is watching.");
            }
            catch (Exception e)
            {
                _castingOn = null;
                Log($"Remote play: screencast failed ({e.Message}).");
            }
        }

        // Stop the screencast once nobody has asked for a frame for a while, so it costs nothing when unused.
        private static void IdleLoop()
        {
            while (true)
            {
                Thread.Sleep(2000);
                var cdp = _castingOn;
                if (cdp != null && DateTime.UtcNow - _lastViewer > TimeSpan.FromSeconds(10))
                {
                    _castingOn = null;
                    try { cdp.Call("Page.stopScreencast").Wait(5000); } catch { /* connection gone */ }
                    Log("Remote play: phone stopped watching.");
                }
            }
        }

        // ---- HTTP ----

        private static void AcceptLoop()
        {
            while (true)
            {
                TcpClient client;
                try { client = _listener.AcceptTcpClient(); }
                catch { return; }
                ThreadPool.QueueUserWorkItem(_ => Handle(client));
            }
        }

        private static void Handle(TcpClient client)
        {
            using (client)
            {
                try
                {
                    client.ReceiveTimeout = 10000;
                    var stream = client.GetStream();
                    var head = ReadHead(stream);
                    if (head == null)
                        return;
                    var lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
                    var parts = lines[0].Split(' ');
                    if (parts.Length < 2)
                        return;
                    var method = parts[0];
                    var target = parts[1];
                    var headers = lines.Skip(1).Where(l => l.Contains(':'))
                        .ToDictionary(l => l.Substring(0, l.IndexOf(':')).Trim().ToLowerInvariant(), l => l.Substring(l.IndexOf(':') + 1).Trim());
                    var q = target.IndexOf('?');
                    var path = q < 0 ? target : target.Substring(0, q);
                    var query = ParseQuery(q < 0 ? "" : target.Substring(q + 1));
                    var body = "";
                    if (headers.TryGetValue("content-length", out var lenText) && int.TryParse(lenText, out var len) && len > 0 && len < 65536)
                        body = Encoding.UTF8.GetString(ReadExact(stream, len));

                    if (path == "/" || path == "/index.html")
                    {
                        Respond(stream, 200, "text/html; charset=utf-8", Encoding.UTF8.GetBytes(_page));
                        return;
                    }
                    var given = headers.TryGetValue("x-token", out var h) ? h : query.TryGetValue("t", out var t) ? t : null;
                    if (!SameToken(given))
                    {
                        Respond(stream, 401, "text/plain", Encoding.UTF8.GetBytes("bad token"));
                        return;
                    }
                    if (path == "/frame" && method == "GET")
                        ServeFrame(stream, query.TryGetValue("after", out var a) && long.TryParse(a, out var after) ? after : 0);
                    else if (path == "/input" && method == "POST")
                    {
                        Input(body).Wait(5000);
                        Respond(stream, 204, "text/plain", new byte[0]);
                    }
                    else
                        Respond(stream, 404, "text/plain", Encoding.UTF8.GetBytes("not found"));
                }
                catch { /* phone went away mid-request */ }
            }
        }

        private static void ServeFrame(Stream stream, long after)
        {
            _lastViewer = DateTime.UtcNow;
            EnsureCasting().Wait(5000);
            byte[] frame;
            long id;
            double w, h;
            lock (FrameLock)
            {
                var until = DateTime.UtcNow.AddSeconds(2);
                while (_frameId <= after)
                {
                    var left = until - DateTime.UtcNow;
                    if (left <= TimeSpan.Zero || !Monitor.Wait(FrameLock, left))
                        break;
                }
                frame = _frame;
                id = _frameId;
                w = _cssW;
                h = _cssH;
            }
            if (frame == null)
            {
                Respond(stream, 503, "text/plain", Encoding.UTF8.GetBytes("no frame yet"));
                return;
            }
            Respond(stream, 200, "image/jpeg", frame,
                $"X-Frame-Id: {id}\r\nX-Css-W: {w.ToString(System.Globalization.CultureInfo.InvariantCulture)}\r\nX-Css-H: {h.ToString(System.Globalization.CultureInfo.InvariantCulture)}\r\n" +
                "Access-Control-Expose-Headers: X-Frame-Id, X-Css-W, X-Css-H\r\n");
        }

        // Phone input in frame fractions -> mouse/key events at the page's CSS coordinates.
        private static async Task Input(string body)
        {
            var cdp = _cdp;
            if (cdp == null || !cdp.IsOpen || !(Json.DeserializeObject(body) is Dictionary<string, object> e))
                return;
            var type = e.TryGetValue("type", out var t) ? t as string : null;
            double Frac(string k) => e.TryGetValue(k, out var v) ? Math.Max(0, Math.Min(1, Convert.ToDouble(v))) : 0;
            double x, y;
            lock (FrameLock) { x = Frac("x") * _cssW; y = Frac("y") * _cssH; }

            Dictionary<string, object> Mouse(string kind, bool down) => new Dictionary<string, object>
            {
                ["type"] = kind, ["x"] = x, ["y"] = y, ["button"] = down || kind == "mouseReleased" ? "left" : "none",
                ["buttons"] = down ? 1 : 0, ["clickCount"] = kind == "mouseMoved" ? 0 : 1,
            };
            switch (type)
            {
                case "down":
                    _pressed = true;
                    await cdp.Call("Input.dispatchMouseEvent", Mouse("mouseMoved", false));
                    await cdp.Call("Input.dispatchMouseEvent", Mouse("mousePressed", true));
                    break;
                case "move":
                    await cdp.Call("Input.dispatchMouseEvent", Mouse("mouseMoved", _pressed));
                    break;
                case "up":
                    _pressed = false;
                    await cdp.Call("Input.dispatchMouseEvent", Mouse("mouseReleased", false));
                    break;
                case "wheel":
                    var dy = e.TryGetValue("dy", out var d) ? Convert.ToDouble(d) : 0;
                    await cdp.Call("Input.dispatchMouseEvent", new Dictionary<string, object>
                    {
                        ["type"] = "mouseWheel", ["x"] = x, ["y"] = y, ["deltaX"] = 0, ["deltaY"] = dy,
                    });
                    break;
                case "key":
                    await Key(cdp, e.TryGetValue("key", out var k) ? k as string : null);
                    break;
            }
        }

        private static readonly Dictionary<string, (string Code, int Vk, string Text)> Keys = new Dictionary<string, (string, int, string)>
        {
            ["Tab"] = ("Tab", 9, null), ["Escape"] = ("Escape", 27, null), [" "] = ("Space", 32, " "), ["Enter"] = ("Enter", 13, "\r"),
            ["F9"] = ("F9", 120, null), ["F10"] = ("F10", 121, null),
        };

        private static async Task Key(Cdp cdp, string key)
        {
            if (key == null || !Keys.TryGetValue(key, out var k))
                return;
            var down = new Dictionary<string, object> { ["type"] = k.Text != null ? "keyDown" : "rawKeyDown", ["key"] = key, ["code"] = k.Code, ["windowsVirtualKeyCode"] = k.Vk };
            if (k.Text != null)
                down["text"] = k.Text;
            await cdp.Call("Input.dispatchKeyEvent", down);
            await cdp.Call("Input.dispatchKeyEvent", new Dictionary<string, object> { ["type"] = "keyUp", ["key"] = key, ["code"] = k.Code, ["windowsVirtualKeyCode"] = k.Vk });
        }

        private static bool SameToken(string given)
        {
            if (given == null || given.Length != _token.Length)
                return false;
            var diff = 0;
            for (var i = 0; i < given.Length; i++)
                diff |= given[i] ^ _token[i];
            return diff == 0;
        }

        private static string ReadHead(Stream s)
        {
            var buf = new List<byte>(1024);
            while (buf.Count < 16384)
            {
                var b = s.ReadByte();
                if (b < 0)
                    return null;
                buf.Add((byte)b);
                var n = buf.Count;
                if (n >= 4 && buf[n - 4] == '\r' && buf[n - 3] == '\n' && buf[n - 2] == '\r' && buf[n - 1] == '\n')
                    return Encoding.ASCII.GetString(buf.ToArray(), 0, n - 4);
            }
            return null;
        }

        private static byte[] ReadExact(Stream s, int n)
        {
            var buf = new byte[n];
            var got = 0;
            while (got < n)
            {
                var r = s.Read(buf, got, n - got);
                if (r <= 0)
                    break;
                got += r;
            }
            return buf;
        }

        private static Dictionary<string, string> ParseQuery(string q) =>
            q.Split('&').Where(p => p.Length > 0).Select(p => p.Split(new[] { '=' }, 2))
                .GroupBy(p => Uri.UnescapeDataString(p[0]))
                .ToDictionary(g => g.Key, g => g.First().Length > 1 ? Uri.UnescapeDataString(g.First()[1].Replace('+', ' ')) : "");

        private static void Respond(Stream s, int status, string type, byte[] body, string extraHeaders = "")
        {
            var reason = status == 200 ? "OK" : status == 204 ? "No Content" : status == 401 ? "Unauthorized" : status == 404 ? "Not Found" : "Error";
            var head = $"HTTP/1.1 {status} {reason}\r\nContent-Type: {type}\r\nContent-Length: {body.Length}\r\nCache-Control: no-store\r\n{extraHeaders}Connection: close\r\n\r\n";
            var h = Encoding.ASCII.GetBytes(head);
            s.Write(h, 0, h.Length);
            s.Write(body, 0, body.Length);
            s.Flush();
        }

        private static void Log(string text) => Program.Say(text);
    }
}
