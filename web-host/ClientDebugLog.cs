using System.Text;
using System.Text.Json;

// Authenticated control-session diagnostics only. Never accept client paths.
internal sealed class ClientDebugLog
{
    private readonly string path = Path.Combine(AppContext.BaseDirectory, "logs",
        $"ipad-{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.log");
    private long bytes;
    private long lastBatch = long.MinValue / 2;
    public bool Append(JsonElement lines)
    {
        if (lines.ValueKind != JsonValueKind.Array || lines.GetArrayLength() > 10)
            return false;
        var now = Environment.TickCount64;
        if (now - lastBatch < 200 || bytes >= 2 * 1024 * 1024) return false;
        lastBatch = now;
        var text = new StringBuilder();
        foreach (var line in lines.EnumerateArray()) {
            if (line.ValueKind != JsonValueKind.String) return false;
            var value = line.GetString()!;
            if (value.Length > 240) return false;
            text.Append(DateTime.UtcNow.ToString("O")).Append(" [iPad] ");
            foreach (var ch in value) text.Append(char.IsControl(ch) ? ' ' : ch);
            text.AppendLine();
        }
        if (text.Length == 0) return true;
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.AppendAllText(path, text.ToString(), Encoding.UTF8);
            if (bytes == 0) Console.WriteLine($"iPad debug log: {path}");
            bytes += Encoding.UTF8.GetByteCount(text.ToString());
            return true;
        } catch (Exception e) when (e is IOException or UnauthorizedAccessException) {
            return false; // Logging must never terminate input.
        }
    }
}
