using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace BirbMod
{
    // Where Birb is installed: Steam's own records, so it works with Steam in any folder and Birb in any library.
    internal static class GameLocator
    {
        private const string AppId = "4364930";
        private const string Fallback = @"C:\Program Files (x86)\Steam\steamapps\common\Birb\birb.exe";

        internal static string Find()
        {
            try
            {
                foreach (var library in Libraries())
                {
                    var apps = Path.Combine(library, "steamapps");
                    var manifest = Path.Combine(apps, $"appmanifest_{AppId}.acf");
                    if (!File.Exists(manifest))
                        continue;
                    var dir = Regex.Match(File.ReadAllText(manifest), "\"installdir\"\\s*\"([^\"]+)\"").Groups[1].Value;
                    var exe = Path.Combine(apps, "common", string.IsNullOrEmpty(dir) ? "Birb" : dir, "birb.exe");
                    if (File.Exists(exe))
                        return exe;
                }
            }
            catch { /* fall back below */ }
            return Fallback;
        }

        // Steam's folder plus every library listed in its libraryfolders.vdf.
        private static string[] Libraries()
        {
            var steam = (Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath", null) as string
                         ?? Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath", null) as string
                         ?? @"C:\Program Files (x86)\Steam").Replace('/', '\\');
            var vdf = Path.Combine(steam, "steamapps", "libraryfolders.vdf");
            var paths = File.Exists(vdf)
                ? Regex.Matches(File.ReadAllText(vdf), "\"path\"\\s*\"([^\"]+)\"").Cast<Match>().Select(m => m.Groups[1].Value.Replace("\\\\", "\\"))
                : Enumerable.Empty<string>();
            return new[] { steam }.Concat(paths).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }
    }
}
