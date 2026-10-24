using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Web.Script.Serialization;

namespace BirbMod
{
    // Self-update for installed copies: before the game starts, look at the repo's latest GitHub release and, if it's
    // newer than this launcher, unpack it over the install and restart. Only runs when update.json (written by the
    // release, naming the repo) sits next to the exe - so a development build never updates itself.
    // The running exe can't be overwritten but can be renamed: it becomes BirbLauncher.exe.old, removed next start.
    // Files the previous release listed in files.txt but the new one doesn't are deleted; anything else is left alone.
    internal static class Updater
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private static string ExeDir => AppDomain.CurrentDomain.BaseDirectory;
        private static string ExePath => Assembly.GetExecutingAssembly().Location;

        internal static Version Current => Assembly.GetExecutingAssembly().GetName().Version;

        // True when it updated and started the new version (this process should exit).
        internal static bool UpdateAndRestart(string[] args)
        {
            TryDelete(ExePath + ".old");
            var repo = Repo();
            if (repo == null)
                return false;
            try
            {
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                var release = Get($"https://api.github.com/repos/{repo}/releases/latest");
                var tag = (string)release["tag_name"];
                if (!Version.TryParse(tag.TrimStart('v', 'V'), out var latest) || Normalize(latest) <= Normalize(Current))
                {
                    Program.Say($"BirbMod {Short(Current)} is up to date.");
                    return false;
                }
                var asset = ((object[])release["assets"]).OfType<Dictionary<string, object>>()
                    .FirstOrDefault(a => ((string)a["name"]).EndsWith(".zip", StringComparison.OrdinalIgnoreCase));
                if (asset == null)
                    return false;

                Program.Say($"Updating BirbMod {Short(Current)} -> {tag}...");
                var temp = Path.Combine(Path.GetTempPath(), "BirbMod-update-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(temp);
                var zip = Path.Combine(temp, "update.zip");
                using (var wc = Client())
                    wc.DownloadFile((string)asset["browser_download_url"], zip);
                var unpacked = Path.Combine(temp, "files");
                ZipFile.ExtractToDirectory(zip, unpacked);
                Install(unpacked);
                TryDelete(temp, recursive: true);

                Program.Say($"Updated to {tag}; restarting.");
                Process.Start(new ProcessStartInfo(ExePath, string.Join(" ", args.Select(a => a.Contains(' ') ? $"\"{a}\"" : a)))
                {
                    UseShellExecute = false,
                    WorkingDirectory = ExeDir,
                });
                return true;
            }
            catch (Exception e)
            {
                Program.Say($"Update check failed ({e.Message}); starting this version.");
                return false;
            }
        }

        private static void Install(string from)
        {
            var oldFiles = ReadList(Path.Combine(ExeDir, "files.txt"));
            var newFiles = ReadList(Path.Combine(from, "files.txt"));
            foreach (var rel in Directory.GetFiles(from, "*", SearchOption.AllDirectories).Select(f => f.Substring(from.Length).TrimStart('\\', '/')))
            {
                var source = Path.Combine(from, rel);
                var target = Path.Combine(ExeDir, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                if (string.Equals(Path.GetFullPath(target), Path.GetFullPath(ExePath), StringComparison.OrdinalIgnoreCase))
                {
                    TryDelete(ExePath + ".old");
                    File.Move(ExePath, ExePath + ".old");
                }
                File.Copy(source, target, true);
            }
            foreach (var gone in oldFiles.Except(newFiles, StringComparer.OrdinalIgnoreCase))
                TryDelete(Path.Combine(ExeDir, gone));
        }

        private static string Repo()
        {
            try
            {
                var path = Path.Combine(ExeDir, "update.json");
                return File.Exists(path) && Json.DeserializeObject(File.ReadAllText(path)) is Dictionary<string, object> d && d.TryGetValue("repo", out var r)
                    ? r as string : null;
            }
            catch { return null; }
        }

        private static Dictionary<string, object> Get(string url)
        {
            using (var wc = Client())
                return (Dictionary<string, object>)Json.DeserializeObject(wc.DownloadString(url));
        }

        private static WebClient Client()
        {
            var wc = new TimeoutClient();
            wc.Headers[HttpRequestHeader.UserAgent] = "BirbMod-launcher";
            return wc;
        }

        private sealed class TimeoutClient : WebClient
        {
            protected override WebRequest GetWebRequest(Uri address)
            {
                var r = base.GetWebRequest(address);
                r.Timeout = 15000;
                return r;
            }
        }

        private static List<string> ReadList(string path) =>
            File.Exists(path) ? File.ReadAllLines(path).Select(l => l.Trim()).Where(l => l.Length > 0).ToList() : new List<string>();

        private static Version Normalize(Version v) => new Version(v.Major, Math.Max(0, v.Minor), Math.Max(0, v.Build));
        private static string Short(Version v) => $"v{v.Major}.{v.Minor}.{Math.Max(0, v.Build)}";

        private static void TryDelete(string path, bool recursive = false)
        {
            try
            {
                if (recursive) { if (Directory.Exists(path)) Directory.Delete(path, true); }
                else if (File.Exists(path)) File.Delete(path);
            }
            catch { /* next time */ }
        }
    }
}
