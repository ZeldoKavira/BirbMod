using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace BirbMod
{
    // Just enough of the Chrome DevTools Protocol to drive the game's WebView2 page: send a command, wait for its reply.
    // Events are ignored. One reader task matches replies to requests by id.
    internal sealed class Cdp : IDisposable
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 256 };

        private readonly ClientWebSocket _ws = new ClientWebSocket();
        private readonly ConcurrentDictionary<int, TaskCompletionSource<Dictionary<string, object>>> _pending =
            new ConcurrentDictionary<int, TaskCompletionSource<Dictionary<string, object>>>();
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private int _nextId;

        internal bool IsOpen => _ws.State == WebSocketState.Open;

        // Protocol events (method, params), raised on the reader thread: handlers must not wait on Call() there.
        internal event Action<string, Dictionary<string, object>> Event;

        internal static async Task<Cdp> ConnectAsync(string url)
        {
            var cdp = new Cdp();
            await cdp._ws.ConnectAsync(new Uri(url), CancellationToken.None);
            _ = Task.Run(cdp.ReadLoop);
            return cdp;
        }

        private async Task ReadLoop()
        {
            var buffer = new byte[64 * 1024];
            try
            {
                while (_ws.State == WebSocketState.Open)
                {
                    using (var ms = new MemoryStream())
                    {
                        WebSocketReceiveResult r;
                        do
                        {
                            r = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                            if (r.MessageType == WebSocketMessageType.Close)
                                return;
                            ms.Write(buffer, 0, r.Count);
                        } while (!r.EndOfMessage);

                        var msg = Json.DeserializeObject(Encoding.UTF8.GetString(ms.ToArray())) as Dictionary<string, object>;
                        if (msg == null)
                            continue;
                        if (msg.TryGetValue("id", out var id))
                        {
                            if (_pending.TryRemove(Convert.ToInt32(id), out var tcs))
                                tcs.TrySetResult(msg);
                        }
                        else if (msg.TryGetValue("method", out var method))
                        {
                            try { Event?.Invoke((string)method, msg.TryGetValue("params", out var p) ? p as Dictionary<string, object> : null); }
                            catch { /* a handler's problem, not the connection's */ }
                        }
                    }
                }
            }
            catch (Exception e)
            {
                foreach (var tcs in _pending.Values)
                    tcs.TrySetException(e);
            }
            finally
            {
                foreach (var tcs in _pending.Values)
                    tcs.TrySetException(new IOException("DevTools connection closed"));
            }
        }

        internal async Task<Dictionary<string, object>> Call(string method, Dictionary<string, object> args = null, int timeoutMs = 20000)
        {
            var id = Interlocked.Increment(ref _nextId);
            var tcs = new TaskCompletionSource<Dictionary<string, object>>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pending[id] = tcs;
            var bytes = Encoding.UTF8.GetBytes(Json.Serialize(new Dictionary<string, object>
            {
                ["id"] = id, ["method"] = method, ["params"] = args ?? new Dictionary<string, object>(),
            }));
            await _sendLock.WaitAsync();
            try { await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None); }
            finally { _sendLock.Release(); }

            if (await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs)) != tcs.Task)
            {
                _pending.TryRemove(id, out _);
                throw new TimeoutException($"{method} got no reply");
            }
            var reply = await tcs.Task;
            if (reply.TryGetValue("error", out var error))
                throw new CdpException($"{method}: {Json.Serialize(error)}");
            return reply.TryGetValue("result", out var result) ? result as Dictionary<string, object> : new Dictionary<string, object>();
        }

        // Evaluates in the page; returns the value (JSON-able results only) or throws with the page's error and line.
        internal async Task<object> Eval(string expression, bool commandLineApi = false)
        {
            var result = await Call("Runtime.evaluate", new Dictionary<string, object>
            {
                ["expression"] = expression, ["returnByValue"] = true, ["awaitPromise"] = true, ["includeCommandLineAPI"] = commandLineApi,
            });
            ThrowIfException(result);
            var value = result["result"] as Dictionary<string, object>;
            return value != null && value.TryGetValue("value", out var v) ? v : null;
        }

        // Evaluates in the page and returns a handle (remote object id) to the result.
        internal async Task<string> EvalHandle(string expression, bool commandLineApi = false)
        {
            var result = await Call("Runtime.evaluate", new Dictionary<string, object>
            {
                ["expression"] = expression, ["returnByValue"] = false, ["includeCommandLineAPI"] = commandLineApi,
            });
            ThrowIfException(result);
            return (result["result"] as Dictionary<string, object>)?.TryGetValue("objectId", out var id) == true ? (string)id : null;
        }

        // An object's properties as (name, value descriptor) pairs; internal ones ([[Scopes]] of a function) included.
        internal async Task<List<KeyValuePair<string, Dictionary<string, object>>>> Properties(string objectId, bool own)
        {
            var result = await Call("Runtime.getProperties", new Dictionary<string, object> { ["objectId"] = objectId, ["ownProperties"] = own });
            var list = new List<KeyValuePair<string, Dictionary<string, object>>>();
            foreach (var key in new[] { "result", "internalProperties" })
                if (result.TryGetValue(key, out var arr) && arr is object[] items)
                    foreach (var item in items)
                        if (item is Dictionary<string, object> p && p.TryGetValue("name", out var name))
                            list.Add(new KeyValuePair<string, Dictionary<string, object>>((string)name,
                                p.TryGetValue("value", out var v) ? v as Dictionary<string, object> : null));
            return list;
        }

        internal async Task<object> CallOn(string objectId, string functionDeclaration)
        {
            var result = await Call("Runtime.callFunctionOn", new Dictionary<string, object>
            {
                ["objectId"] = objectId, ["functionDeclaration"] = functionDeclaration, ["returnByValue"] = true,
            });
            ThrowIfException(result);
            var value = result["result"] as Dictionary<string, object>;
            return value != null && value.TryGetValue("value", out var v) ? v : null;
        }

        private static void ThrowIfException(Dictionary<string, object> result)
        {
            if (!result.TryGetValue("exceptionDetails", out var detailsObj) || !(detailsObj is Dictionary<string, object> details))
                return;
            var text = details.TryGetValue("exception", out var ex) && ex is Dictionary<string, object> exObj && exObj.TryGetValue("description", out var desc)
                ? desc as string
                : details.TryGetValue("text", out var t) ? t as string : "error";
            var line = details.TryGetValue("lineNumber", out var ln) ? Convert.ToInt32(ln) : -1;
            throw new CdpException(line >= 0 ? $"{text} (line {line})" : text);
        }

        public void Dispose()
        {
            try { _ws.Abort(); } catch { }
            _ws.Dispose();
        }
    }

    internal sealed class CdpException : Exception
    {
        internal CdpException(string message) : base(message) { }
    }
}
