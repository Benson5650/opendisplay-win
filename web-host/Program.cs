using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

Native.SetProcessDpiAwarenessContext(new nint(-4));
var builder = WebApplication.CreateBuilder(args);
var ipText = builder.Configuration["ip"] ?? "127.0.0.1";
if (!IPAddress.TryParse(ipText, out var ip)) throw new ArgumentException("--ip must be an IP address");
var port = int.Parse(builder.Configuration["port"] ?? "9443");
var dryRun = builder.Configuration["dry-run"] == "true";
var certPath = builder.Configuration["cert"] ?? throw new ArgumentException("--cert PFX is required");
var cert = X509CertificateLoader.LoadPkcs12FromFile(certPath, Environment.GetEnvironmentVariable("OD_PFX_PASSWORD"));
if (!cert.HasPrivateKey || !cert.MatchesHostname(ipText, false, false))
    throw new ArgumentException("Certificate must have a private key and matching IP SAN");
builder.WebHost.ConfigureKestrel(o => o.Listen(ip, port, l => l.UseHttps(cert)));
builder.Logging.ClearProviders(); // Never log pairing credentials or input payloads.
var app = builder.Build();
var host = ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? $"[{ipText}]:{port}" : $"{ipText}:{port}";
var origin = $"https://{host}";
var gate = new object();
var native = Native.od_create(dryRun ? 1 : 0);
if (native == 0) throw new InvalidOperationException("Native initialization failed");
string? owner = null;
VideoSession? video = null;
void CancelVideo() { video?.Cancel(); }
var tokens = new HashSet<string>();
var code = Convert.ToHexString(RandomNumberGenerator.GetBytes(6));
var codeExpires = DateTimeOffset.UtcNow.AddMinutes(5);
string? pending = null;
bool approved = false;
var lastPair = DateTimeOffset.MinValue;
var disposed = false;
Console.WriteLine($"OpenDisplay Web: {origin}\nMode: {(dryRun ? "DRY RUN (no desktop input)" : "LIVE INPUT")}\nPairing code: {code}\nExpires in 5 minutes. Commands: approve, pair (new code), revoke, quit.");

_ = Task.Run(() => {
    while (Console.ReadLine() is { } command) {
        lock (gate) {
            if (disposed) return;
            switch (command.Trim()) {
                case "approve":
                    if (pending != null && DateTimeOffset.UtcNow < codeExpires) {
                        approved = true; Console.WriteLine("Pending device approved.");
                    } else Console.WriteLine("No unexpired pending device.");
                    break;
                case "pair":
                    code = Convert.ToHexString(RandomNumberGenerator.GetBytes(6));
                    codeExpires = DateTimeOffset.UtcNow.AddMinutes(5);
                    pending = null; approved = false;
                    Console.WriteLine($"Pairing code: {code}");
                    break;
                case "revoke":
                    tokens.Clear(); Native.od_stop(native); CancelVideo(); Console.WriteLine("All device sessions revoked.");
                    break;
                case "quit": app.Lifetime.StopApplication(); return;
            }
        }
    }
});
bool Auth(HttpContext c) {
    lock (gate) return c.Request.Cookies.TryGetValue("od-device", out var token) && tokens.Contains(token);
}
app.Use(async (c, next) => {
    c.Response.Headers["Cache-Control"] = "no-store";
    c.Response.Headers["X-Content-Type-Options"] = "nosniff";
    c.Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    if (!string.Equals(c.Request.Host.Value, host, StringComparison.OrdinalIgnoreCase)) { c.Response.StatusCode = 400; return; }
    if ((c.Request.Method != "GET" || c.Request.Path == "/control" || c.Request.Path == "/video") && c.Request.Headers.Origin != origin) {
        c.Response.StatusCode = 403; return;
    }
    await next();
});
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(10) });
app.UseDefaultFiles(); app.UseStaticFiles();
app.MapPost("/pair", async (HttpContext c) => {
    if (c.Request.ContentLength is null or > 1024) return Results.BadRequest();
    JsonDocument doc;
    try { doc = await JsonDocument.ParseAsync(c.Request.Body); } catch (JsonException) { return Results.BadRequest(); }
    using (doc) lock (gate) {
        if (DateTimeOffset.UtcNow - lastPair < TimeSpan.FromSeconds(1)) return Results.StatusCode(429);
        lastPair = DateTimeOffset.UtcNow;
        if (pending != null || DateTimeOffset.UtcNow >= codeExpires ||
            !doc.RootElement.TryGetProperty("code", out var supplied) || supplied.ValueKind != JsonValueKind.String ||
            supplied.GetString() != code) return Results.Unauthorized();
        pending = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        approved = false;
        Console.WriteLine("Device requests pairing. Type approve on this host to permit it.");
        return Results.Json(new { ticket = pending });
    }
});
app.MapPost("/pair/status", async (HttpContext c) => {
    if (c.Request.ContentLength is null or > 1024) return Results.BadRequest();
    JsonDocument doc;
    try { doc = await JsonDocument.ParseAsync(c.Request.Body); } catch (JsonException) { return Results.BadRequest(); }
    using (doc) lock (gate) {
        if (pending == null || DateTimeOffset.UtcNow >= codeExpires ||
            !doc.RootElement.TryGetProperty("ticket", out var t) || t.ValueKind != JsonValueKind.String || t.GetString() != pending)
            return Results.Unauthorized();
        if (!approved) return Results.Json(new { ready = false });
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        tokens.Add(token); pending = null; codeExpires = DateTimeOffset.MinValue;
        c.Response.Cookies.Append("od-device", token, new CookieOptions { HttpOnly = true, Secure = true, SameSite = SameSiteMode.Strict });
        return Results.Json(new { ready = true });
    }
});
app.MapGet("/displays", (HttpContext c) => {
    if (!Auth(c)) return Results.Unauthorized();
    lock (gate) {
        var text = new StringBuilder(65536);
        return Native.od_displays(text, text.Capacity) == 1 ? Results.Text(text.ToString(), "application/json") : Results.StatusCode(503);
    }
});
app.Map("/control", async (HttpContext c) => {
    if (!Auth(c)) { c.Response.StatusCode = 401; return; }
    if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }
    var connection = Guid.NewGuid().ToString();
    lock (gate) {
        if (owner != null) { c.Response.StatusCode = 409; return; }
        owner = connection;
    }
    var ownedVideos = new List<VideoSession>();
    try {
        using var socket = await c.WebSockets.AcceptWebSocketAsync();
        using var shutdown = CancellationTokenSource.CreateLinkedTokenSource(c.RequestAborted, app.Lifetime.ApplicationStopping);
        var ct = shutdown.Token;
        var sendLock = new SemaphoreSlim(1);
        async Task Send(object message) {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
            await sendLock.WaitAsync(ct);
            try { await socket.SendAsync(bytes, WebSocketMessageType.Text, true, ct); }
            finally { sendLock.Release(); }
        }
        var watchdog = Task.Run(async () => {
            int previous = 0;
            try {
                using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(100));
                while (await timer.WaitForNextTickAsync(ct)) {
                    int state;
                    lock (gate) {
                        if (!Auth(c)) { Native.od_stop(native); CancelVideo(); shutdown.Cancel(); socket.Abort(); return; }
                        state = Native.od_tick(native);
                        if (state != 1) CancelVideo();
                    }
                    if (state != previous) { previous = state; await Send(new { type = "state", state }); }
                }
            } catch (OperationCanceledException) {} catch (WebSocketException) { shutdown.Cancel(); }
        }, ct);
        try {
            await Send(new { type = "hello", protocol = 1, dryRun });
            var buffer = new byte[8192];
            while (!ct.IsCancellationRequested && socket.State == WebSocketState.Open) {
                var count = 0; WebSocketReceiveResult part;
                do {
                    part = await socket.ReceiveAsync(new ArraySegment<byte>(buffer, count, buffer.Length - count), ct);
                    if (part.MessageType == WebSocketMessageType.Close) return;
                    count += part.Count;
                    if (part.MessageType != WebSocketMessageType.Text || count == buffer.Length) throw new JsonException("Frame rejected");
                } while (!part.EndOfMessage);
                using var doc = JsonDocument.Parse(buffer.AsMemory(0, count));
                var m = doc.RootElement;
                var type = m.GetProperty("type").GetString();
                object response;
                lock (gate) {
                    if (!Auth(c)) break;
                    switch (type) {
                        case "start":
                            Native.od_stop(native); CancelVideo(); video = null;
                            var width = m.GetProperty("width").GetDouble(); var height = m.GetProperty("height").GetDouble();
                            var mapping = m.GetProperty("mapping").GetString();
                            var mode = m.TryGetProperty("mode", out var modeValue) ? modeValue.GetString() : "pen";
                            if (mode is not ("pen" or "mirror" or "extend")) throw new JsonException("Unsupported mode");
                            if (mode != "pen" && mapping != "preserve") throw new JsonException("Video requires aspect preservation");
                            var fps = m.TryGetProperty("fps", out var fpsValue) ? fpsValue.GetUInt32() : 30;
                            if (fps is not (30 or 60)) throw new JsonException("Unsupported frame rate");
                            if (width is <= 0 or > 16384 || height is <= 0 or > 16384 || mapping is not ("preserve" or "stretch")) throw new JsonException();
                            var target = m.GetProperty("target").GetString() ?? "";
                            nint ownedDisplay = 0;
                            if (mode == "extend") {
                                var panelWidth = m.GetProperty("panelWidth").GetUInt32();
                                var panelHeight = m.GetProperty("panelHeight").GetUInt32();
                                var identity = new StringBuilder(4096);
                                ownedDisplay = Native.od_extend_create(panelWidth, panelHeight, identity, identity.Capacity);
                                if (ownedDisplay == 0) {
                                    response = new { type = "started", generation = 0, error = "EXTEND_UNAVAILABLE_REGISTER_RESOLUTION_LOCALLY" };
                                    break;
                                }
                                target = identity.ToString();
                            }
                            try {
                            var generation = Native.od_start(native, target, width, height, mapping == "stretch" ? 1 : 0);
                            if (generation != 0 && mode != "pen") {
                                video = new VideoSession(target, fps, generation, c.Request.Cookies["od-device"]!, ownedDisplay);
                                ownedDisplay = 0;
                                ownedVideos.Add(video);
                            }
                            response = new { type = "started", generation, videoTicket = video?.Ticket, error = generation == 0 ? "TARGET_OR_MAPPING_INVALID" : null };
                            } finally { if (ownedDisplay != 0) Native.od_extend_destroy(ownedDisplay); }
                            break;
                        case "stop": Native.od_stop(native); CancelVideo(); response = new { type = "stopped" }; break;
                        case "keyframe":
                            if (video?.Generation == m.GetProperty("generation").GetUInt64()) video.RequestKeyFrame();
                            response = new { type = "keyframe" }; break;
                        case "heartbeat":
                            var alive = Native.od_heartbeat(native, m.GetProperty("generation").GetUInt64());
                            response = new { type = "heartbeat", alive }; break;
                        case "pen":
                            var ok = Native.od_sample(native, m.GetProperty("generation").GetUInt64(), m.GetProperty("sequence").GetUInt64(),
                                m.GetProperty("phase").GetInt32(), m.GetProperty("x").GetDouble(), m.GetProperty("y").GetDouble(),
                                m.GetProperty("pressure").GetDouble(), m.GetProperty("azimuth").GetDouble(), m.GetProperty("altitude").GetDouble());
                            if (!dryRun) continue;
                            response = new { type = "sample", accepted = ok, emitted = Native.od_emitted(native) }; break;
                        default: throw new JsonException("Unknown message");
                    }
                }
                await Send(response);
            }
        } catch (Exception e) when (e is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or WebSocketException or OperationCanceledException) {
            Console.Error.WriteLine($"Control ended: {e.GetType().Name}");
            // Malformed or lost connections always release input in finally.
        } finally {
            shutdown.Cancel(); socket.Abort();
            try { await watchdog; } catch (OperationCanceledException) {}
            sendLock.Dispose();
        }
    } finally {
        lock (gate) { Native.od_stop(native); CancelVideo(); video = null; owner = null; }
        foreach (var oldVideo in ownedVideos) oldVideo.Dispose();
    }
});
app.Map("/video", async (HttpContext c) => {
    if (!Auth(c)) { c.Response.StatusCode = 401; return; }
    if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }
    VideoSession selected;
    lock (gate) {
        if (owner == null || video == null || video.DeviceToken != c.Request.Cookies["od-device"] ||
            video.Ticket != c.Request.Query["ticket"] || !video.Attach()) { c.Response.StatusCode = 403; return; }
        selected = video;
    }
    try {
        using var socket = await c.WebSockets.AcceptWebSocketAsync();
        await selected.Stream(socket, c.RequestAborted);
    } catch (Exception e) when (e is OperationCanceledException or WebSocketException or InvalidOperationException) {
        // A failed video connection invalidates input for this generation only.
    } finally {
        lock (gate) {
            if (ReferenceEquals(video, selected)) { Native.od_stop(native); selected.Cancel(); }
        }
    }
});
try { await app.RunAsync(); }
finally { lock (gate) { disposed = true; Native.od_destroy(native); } cert.Dispose(); }
