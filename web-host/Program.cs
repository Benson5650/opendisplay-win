using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

Native.EnsureDefaultDesktop();
Native.SetProcessDpiAwarenessContext(new nint(-4));
var builder = WebApplication.CreateBuilder(args);
var ipText = builder.Configuration["ip"] ?? "127.0.0.1";
if (!IPAddress.TryParse(ipText, out var ip)) throw new ArgumentException("--ip must be an IP address");
var port = int.Parse(builder.Configuration["port"] ?? "9443");
var dryRun = builder.Configuration["dry-run"] == "true";
var localTest = builder.Configuration["loopback-test"] == "true";
if (localTest && (!IPAddress.IsLoopback(ip) || !dryRun)) throw new ArgumentException("Loopback test requires loopback IP and dry-run input");
var certPath = builder.Configuration["cert"];
using var cert = localTest ? null : X509CertificateLoader.LoadPkcs12FromFile(certPath ?? throw new ArgumentException("--cert PFX is required"), Environment.GetEnvironmentVariable("OD_PFX_PASSWORD"));
if (cert != null && (!cert.HasPrivateKey || !cert.MatchesHostname(ipText, false, false)))
    throw new ArgumentException("Certificate must have a private key and matching IP SAN");
builder.WebHost.ConfigureKestrel(o => o.Listen(ip, port, l => { if(cert != null) l.UseHttps(cert); }));
builder.Logging.ClearProviders(); // Never log pairing credentials or input payloads.
var app = builder.Build();
var host = ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? $"[{ipText}]:{port}" : $"{ipText}:{port}";
var origin = $"{(localTest ? "http" : "https")}://{host}";
var gate = new object();
var native = Native.od_create(dryRun ? 1 : 0);
if (native == 0) throw new InvalidOperationException("Native initialization failed");
string? owner = null;
VideoSession? video = null;
void CancelVideo() { video?.Cancel(); }
// Store only SHA256 token hashes; the credential stays in an HttpOnly cookie.
var pairingFile = Path.GetFullPath(builder.Configuration["pairing-store"] ?? Path.Combine(AppContext.BaseDirectory, "paired-devices.json"));
var tokens = new Dictionary<string, DateTimeOffset>();
if (!localTest && File.Exists(pairingFile)) {
    try { tokens = JsonSerializer.Deserialize<Dictionary<string, DateTimeOffset>>(File.ReadAllText(pairingFile)) ?? new(); }
    catch (JsonException) { Console.Error.WriteLine("Pairing store invalid; please pair again."); }
}
string TokenHash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
void SavePairings() {
    if (localTest) return;
    var temp = pairingFile + ".tmp";
    File.WriteAllText(temp, JsonSerializer.Serialize(tokens));
    File.Move(temp, pairingFile, true);
}
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
                    tokens.Clear(); SavePairings(); Native.od_stop(native); CancelVideo(); Console.WriteLine("All device sessions revoked.");
                    break;
                case "quit": app.Lifetime.StopApplication(); return;
            }
        }
    }
});
bool Auth(HttpContext c) {
    lock (gate) return c.Request.Cookies.TryGetValue("od-device", out var token) &&
        tokens.TryGetValue(TokenHash(token), out var expiry) && expiry > DateTimeOffset.UtcNow;
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
        var expiry = DateTimeOffset.UtcNow.AddDays(30);
        tokens[TokenHash(token)] = expiry; SavePairings(); pending = null; codeExpires = DateTimeOffset.MinValue;
        c.Response.Cookies.Append("od-device", token, new CookieOptions { HttpOnly = true, Secure = !localTest, SameSite = SameSiteMode.Strict, Expires = expiry });
        return Results.Json(new { ready = true });
    }
});
app.MapPost("/unpair", (HttpContext c) => {
    if (!Auth(c)) return Results.Unauthorized();
    lock (gate) {
        tokens.Remove(TokenHash(c.Request.Cookies["od-device"]!));
        SavePairings();
        // Control watchdog sees revoked auth and releases only its session.
        c.Response.Cookies.Delete("od-device", new CookieOptions { Secure = !localTest, HttpOnly = true, SameSite = SameSiteMode.Strict });
        return Results.Json(new { forgotten = true });
    }
});
app.MapGet("/displays", (HttpContext c) => {
    if (!Auth(c)) return Results.Unauthorized();
    lock (gate) {
        var text = new StringBuilder(65536);
        return Native.od_displays(text, text.Capacity) == 1 ? Results.Text(text.ToString(), "application/json") : Results.StatusCode(503);
    }
});
app.MapPost("/identify", (HttpContext c) => {
    if (!Auth(c)) return Results.Unauthorized();
    Console.WriteLine(">>> Identify displays triggered");
    Native.od_identify_displays();
    return Results.Json(new { ok = true });
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
    string fingerMode = "off";
    double trackpadSensitivity = 1.25;
    bool penContact = false;
    string pressureCurve = "linear";
    long lastPenAt = long.MinValue / 2;
    bool regionEditing = false;
    ulong sessionGeneration = 0;
    string sessionMode = "", sessionTarget = "";
    double sessionWidth = 0, sessionHeight = 0;
    (double x,double y,double width,double height) currentRegion = (0,0,1,1);
    (double x,double y,double width,double height) originalRegion = currentRegion;
    static (double x,double y,double width,double height) ReadRegion(JsonElement value) {
        var region=(value.GetProperty("x").GetDouble(),value.GetProperty("y").GetDouble(),
            value.GetProperty("width").GetDouble(),value.GetProperty("height").GetDouble());
        if (!double.IsFinite(region.Item1)||!double.IsFinite(region.Item2)||
            !double.IsFinite(region.Item3)||!double.IsFinite(region.Item4)||
            region.Item1<0||region.Item2<0||region.Item3<=0||region.Item4<=0||
            region.Item1+region.Item3>1.0000001||region.Item2+region.Item4>1.0000001)
            throw new JsonException("Invalid target region");
        return region;
    }
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
                    object? regionEvent = null;
                    lock (gate) {
                        if (!Auth(c)) { Native.od_stop(native); CancelVideo(); shutdown.Cancel(); socket.Abort(); return; }
                        state = Native.od_tick(native);
                        if (state == 1 && fingerMode == "touch") Native.od_touch_refresh(native);
                        if (video?.AttachmentTimedOut == true) {
                            Console.Error.WriteLine("Video attach timeout: browser did not connect within 10s");
                            Native.od_stop(native); CancelVideo();
                            shutdown.Cancel(); socket.Abort(); return;
                        }
                        if (state != 1) CancelVideo();
                        if (state != 1 && regionEditing) {
                            Native.od_region_edit_end(native,0); regionEditing=false;
                        } else if (state == 1 && regionEditing) {
                            var editState=Native.od_region_edit_poll(native,out var rx,out var ry,out var rw,out var rh);
                            if (editState != 0) {
                                var next=(x:rx,y:ry,width:rw,height:rh);
                                if (editState == 3) next=originalRegion;
                                if (Native.od_set_region(native,sessionGeneration,next.x,next.y,next.width,next.height)!=0)
                                    currentRegion=next;
                                if (editState is 2 or 3) regionEditing=false;
                                regionEvent=new { type="regionChanged", state=editState switch { 2=>"committed",3=>"canceled",_=>"active" },
                                    source="windows", region=new { currentRegion.x,currentRegion.y,currentRegion.width,currentRegion.height } };
                            }
                        }
                    }
                    if (state != previous) {
                        Console.Error.WriteLine($"Session state: {previous} -> {state}");
                        previous = state; await Send(new { type = "state", state });
                    }
                    if (regionEvent != null) await Send(regionEvent);
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
                            pressureCurve = m.TryGetProperty("pressureCurve", out var curveValue) ? curveValue.GetString() ?? "linear" : "linear";
                            _ = PressureCurve.Apply(0, pressureCurve);
                            penContact = false;
                            lastPenAt = long.MinValue / 2;
                            if (m.TryGetProperty("fingerMode", out var fingerModeValue))
                                fingerMode = fingerModeValue.GetString() ?? "off";
                            else
                                fingerMode = m.TryGetProperty("touch", out var touchValue) && touchValue.GetBoolean() ? "legacy" : "off";
                            if (fingerMode is not ("off" or "trackpad" or "touch" or "legacy")) throw new JsonException("Invalid finger mode");
                            var sensitivityName = m.TryGetProperty("trackpadSensitivity", out var sensitivityValue) ? sensitivityValue.GetString() : "normal";
                            trackpadSensitivity = sensitivityName switch { "slow" => .75, "normal" => 1.25, "fast" => 2.0, _ => throw new JsonException("Invalid trackpad sensitivity") };
                            Native.od_region_edit_end(native,0); regionEditing=false;
                            Native.od_stop(native); CancelVideo(); video = null;
                            var width = m.GetProperty("width").GetDouble(); var height = m.GetProperty("height").GetDouble();
                            var mapping = m.GetProperty("mapping").GetString();
                            var mode = m.TryGetProperty("mode", out var modeValue) ? modeValue.GetString() : "pen";
                            if (mode is not ("pen" or "mirror" or "extend")) throw new JsonException("Unsupported mode");
                            if (mode != "pen" && mapping != "preserve") throw new JsonException("Video requires aspect preservation");
                            var fps = m.TryGetProperty("fps", out var fpsValue) ? fpsValue.GetUInt32() : 30;
                            if (fps is not (30 or 60)) throw new JsonException("Unsupported frame rate");
                            var quality = m.TryGetProperty("quality", out var qualityValue) ? qualityValue.GetString() : "balanced";
                            uint bitrate = quality switch { "fast" => 4_000_000, "balanced" => 12_000_000, "high" => 24_000_000, _ => throw new JsonException("Invalid quality") };
                            if (width is <= 0 or > 16384 || height is <= 0 or > 16384 || mapping is not ("preserve" or "stretch")) throw new JsonException();
                            var target = m.GetProperty("target").GetString() ?? "";
                            double regionX = 0, regionY = 0, regionWidth = 1, regionHeight = 1;
                            if (mode == "pen" && m.TryGetProperty("targetRegion", out var regionValue)) {
                                regionX=regionValue.GetProperty("x").GetDouble();
                                regionY=regionValue.GetProperty("y").GetDouble();
                                regionWidth=regionValue.GetProperty("width").GetDouble();
                                regionHeight=regionValue.GetProperty("height").GetDouble();
                            }
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
                            var hideCursor = m.TryGetProperty("hideCursor", out var hideVal) && hideVal.GetBoolean();
                            Native.od_set_cursor_feedback(native, hideCursor ? 0 : 1);
                            var resolutionScale = m.TryGetProperty("resolutionScale", out var scaleVal) ? scaleVal.GetDouble() : 1.0;
                            try {
                            // Pen Tablet always uses the complete iPad surface. Its optional
                            // region selects the Windows destination, not a smaller iPad area.
                            var generation = Native.od_start_region(native, target, width, height,
                                mode == "pen" || mapping == "stretch" ? 1 : 0,
                                regionX, regionY, regionWidth, regionHeight);
                            if (generation != 0) {
                                sessionGeneration=generation; sessionMode=mode; sessionTarget=target;
                                sessionWidth=width; sessionHeight=height;
                                currentRegion=(regionX,regionY,regionWidth,regionHeight);
                            }
                            if (generation != 0 && mode != "pen") {
                                video = new VideoSession(target, fps, generation, c.Request.Cookies["od-device"]!, ownedDisplay, bitrate, resolutionScale);
                                ownedDisplay = 0;
                                ownedVideos.Add(video);
                            }
                            response = new { type = "started", generation, videoTicket = video?.Ticket, error = generation == 0 ? "TARGET_OR_MAPPING_INVALID" : null };
                            } finally { if (ownedDisplay != 0) Native.od_extend_destroy(ownedDisplay); }
                            break;
                        case "stop": Native.od_region_edit_end(native,0); regionEditing=false; Native.od_stop(native); CancelVideo(); response = new { type = "stopped" }; break;
                        case "regionEditBegin": {
                            var editGeneration=m.GetProperty("generation").GetUInt64();
                            if (sessionMode!="pen"||editGeneration!=sessionGeneration||Native.od_tick(native)!=1)
                                throw new InvalidOperationException("Region editor requires an active Pen Tablet session");
                            Native.od_cancel_finger(native);
                            originalRegion=currentRegion;
                            if (Native.od_set_region(native,sessionGeneration,currentRegion.x,currentRegion.y,currentRegion.width,currentRegion.height)==0)
                                throw new InvalidOperationException("Region editor could not pause input");
                            if (Native.od_region_edit_begin(native,sessionTarget,sessionWidth,sessionHeight,
                                currentRegion.x,currentRegion.y,currentRegion.width,currentRegion.height)==0)
                                throw new InvalidOperationException("Windows region editor unavailable");
                            regionEditing=true;
                            response=new { type="regionChanged",state="active",source="ipad",
                                region=new { currentRegion.x,currentRegion.y,currentRegion.width,currentRegion.height } };
                            break;
                        }
                        case "regionEditUpdate": {
                            if (!regionEditing||m.GetProperty("generation").GetUInt64()!=sessionGeneration)
                                throw new InvalidOperationException("Region editor is not active");
                            var next=ReadRegion(m.GetProperty("region"));
                            Native.od_cancel_finger(native);
                            if (Native.od_set_region(native,sessionGeneration,next.x,next.y,next.width,next.height)==0||
                                Native.od_region_edit_update(native,next.x,next.y,next.width,next.height)==0)
                                throw new InvalidOperationException("Region update rejected");
                            currentRegion=next;
                            response=new { type="regionChanged",state="active",source="ipad",
                                region=new { currentRegion.x,currentRegion.y,currentRegion.width,currentRegion.height } };
                            break;
                        }
                        case "regionEditEnd": {
                            if (!regionEditing||m.GetProperty("generation").GetUInt64()!=sessionGeneration)
                                throw new InvalidOperationException("Region editor is not active");
                            var commit=m.GetProperty("commit").GetBoolean();
                            if (!commit) {
                                currentRegion=originalRegion;
                                Native.od_set_region(native,sessionGeneration,currentRegion.x,currentRegion.y,currentRegion.width,currentRegion.height);
                            }
                            Native.od_region_edit_end(native,commit?1:0); regionEditing=false;
                            response=new { type="regionChanged",state=commit?"committed":"canceled",source="ipad",
                                region=new { currentRegion.x,currentRegion.y,currentRegion.width,currentRegion.height } };
                            break;
                        }
                        case "keyframe":
                            if (video?.Generation == m.GetProperty("generation").GetUInt64()) video.RequestKeyFrame();
                            response = new { type = "keyframe" }; break;
                        case "heartbeat":
                            var alive = Native.od_heartbeat(native, m.GetProperty("generation").GetUInt64());
                            response = new { type = "heartbeat", alive }; break;
                        case "pen":
                            if (regionEditing) { response=new { type="sample",accepted=0,emitted=Native.od_emitted(native) }; break; }
                            lastPenAt = Environment.TickCount64;
                            Native.od_cancel_finger(native);
                            var ok = Native.od_sample(native, m.GetProperty("generation").GetUInt64(), m.GetProperty("sequence").GetUInt64(),
                                m.GetProperty("phase").GetInt32(), m.GetProperty("x").GetDouble(), m.GetProperty("y").GetDouble(),
                                PressureCurve.Apply(m.GetProperty("pressure").GetDouble(),pressureCurve), m.GetProperty("azimuth").GetDouble(), m.GetProperty("altitude").GetDouble());
                            if(ok != 0) penContact = m.GetProperty("phase").GetInt32() is 0 or 1;
                            if (!dryRun) continue;
                            response = new { type = "sample", accepted = ok, emitted = Native.od_emitted(native) }; break;
                        case "touch":
                            if (regionEditing) { response=new { type="sample",accepted=0,emitted=Native.od_emitted(native) }; break; }
                            var phase = m.GetProperty("phase").GetInt32();
                            var accepted = 0;
                            if (fingerMode == "legacy" && !penContact && Environment.TickCount64-lastPenAt > 700)
                                accepted = Native.od_touch(native,m.GetProperty("generation").GetUInt64(),m.GetProperty("sequence").GetUInt64(),phase,m.GetProperty("x").GetDouble(),m.GetProperty("y").GetDouble());
                            if (!dryRun) continue;
                            response = new { type="sample",accepted,emitted=Native.od_emitted(native) }; break;
                        case "trackpad":
                            if (regionEditing) { response=new { type="sample",accepted=0,emitted=Native.od_emitted(native) }; break; }
                            var actionName = m.GetProperty("action").GetString();
                            var action = actionName switch { "move" => 0, "leftDown" => 1, "leftUp" => 2,
                                "rightDown" => 3, "rightUp" => 4, "scroll" => 5, _ => -1 };
                            if (action < 0) throw new JsonException("Invalid trackpad action");
                            var deltaX = m.TryGetProperty("dx", out var dxValue) ? dxValue.GetDouble() : 0;
                            var deltaY = m.TryGetProperty("dy", out var dyValue) ? dyValue.GetDouble() : 0;
                            if (!double.IsFinite(deltaX) || !double.IsFinite(deltaY) || Math.Abs(deltaX) > 256 || Math.Abs(deltaY) > 256)
                                throw new JsonException("Invalid trackpad delta");
                            var trackpadAccepted = 0;
                            if (fingerMode == "trackpad" && !penContact && Environment.TickCount64-lastPenAt > 700)
                                trackpadAccepted = Native.od_trackpad(native, m.GetProperty("generation").GetUInt64(),
                                    m.GetProperty("sequence").GetUInt64(), action,
                                    action == 0 ? deltaX * trackpadSensitivity : deltaX,
                                    action == 0 ? deltaY * trackpadSensitivity : deltaY);
                            if (!dryRun) continue;
                            response = new { type="sample",accepted=trackpadAccepted,emitted=Native.od_emitted(native) }; break;
                        case "directTouch":
                            if (regionEditing) { response=new { type="sample",accepted=0,emitted=Native.od_emitted(native) }; break; }
                            var directPhase = m.GetProperty("phase").GetInt32();
                            if (directPhase is < 0 or > 3) throw new JsonException("Invalid touch phase");
                            var directX = m.GetProperty("x").GetDouble();
                            var directY = m.GetProperty("y").GetDouble();
                            if (!double.IsFinite(directX) || !double.IsFinite(directY)) throw new JsonException("Invalid touch point");
                            var directAccepted = 0;
                            if (fingerMode == "touch" && !penContact && Environment.TickCount64-lastPenAt > 700)
                                directAccepted = Native.od_direct_touch(native, m.GetProperty("generation").GetUInt64(),
                                    m.GetProperty("sequence").GetUInt64(),m.GetProperty("contactId").GetUInt32(),
                                    directPhase,directX,directY);
                            if (!dryRun) continue;
                            response = new { type="sample",accepted=directAccepted,emitted=Native.od_emitted(native) }; break;
                        default: throw new JsonException("Unknown message");
                    }
                }
                await Send(response);
            }
        } catch (OperationCanceledException) {
            // Normal when the page stops a session, disconnects, or the host exits.
        } catch (Exception e) when (e is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or WebSocketException) {
            Console.Error.WriteLine($"Control ended: {e.GetType().Name}");
            // Malformed or lost connections always release input in finally.
        } finally {
            shutdown.Cancel(); socket.Abort();
            try { await watchdog; } catch (OperationCanceledException) {}
            sendLock.Dispose();
        }
    } finally {
        lock (gate) { Native.od_region_edit_end(native,0); Native.od_stop(native); CancelVideo(); video = null; owner = null; }
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
    } catch (OperationCanceledException) {
        // Expected when control sends stop or the browser closes the video socket.
    } catch (Exception e) when (e is WebSocketException or InvalidOperationException or TimeoutException) {
        // A failed video connection invalidates input for this generation only.
        Console.Error.WriteLine($"Video ended: {e.GetType().Name}: {e.Message}");
    } finally {
        lock (gate) {
            if (ReferenceEquals(video, selected)) { Native.od_stop(native); selected.Cancel(); }
        }
    }
});
try { await app.RunAsync(); }
finally { lock (gate) { disposed = true; Native.od_destroy(native); } }
