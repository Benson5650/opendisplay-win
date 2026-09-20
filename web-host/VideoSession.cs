using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.WebSockets;

// One instance per control-session generation. No input/global gate is held
// during capture, socket IO, or worker destruction.
internal sealed class VideoSession : IDisposable
{
    readonly object gate = new();
    nint handle;
    nint virtualDisplay;
    bool attached;
    readonly Stopwatch created = Stopwatch.StartNew();
    int cleanupQueued;
    readonly CancellationTokenSource stopped = new();
    public string Ticket { get; } = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
    public string DeviceToken { get; }
    public ulong Generation { get; }
    public VideoSession(string target, uint fps, ulong generation, string token, nint ownedDisplay = 0, uint bitrate = 12_000_000)
    {
        Generation = generation; DeviceToken = token;
        handle = Native.od_video_create(target, fps, bitrate);
        if (handle == 0) throw new InvalidOperationException("Video target unavailable");
        virtualDisplay = ownedDisplay;
    }
    public bool Attach()
    {
        lock(gate) { if (attached || handle == 0 || stopped.IsCancellationRequested) return false; attached = true; return true; }
    }
    public bool AttachmentTimedOut {
        get { lock(gate) return !attached && created.Elapsed > TimeSpan.FromSeconds(10); }
    }
    public void RequestKeyFrame() { lock(gate) if(handle != 0) Native.od_video_keyframe(handle); }
    public void Cancel()
    {
        stopped.Cancel();
        if (Interlocked.Exchange(ref cleanupQueued, 1) == 0)
            _ = Task.Run(ReleaseNative); // Never join capture while holding input gate.
    }
    public async Task Stream(WebSocket socket, CancellationToken request)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(request, stopped.Token);
        var ct = linked.Token;
        var pixels = new byte[8 * 1024 * 1024];
        var clock = Stopwatch.StartNew();
        try {
            while (!ct.IsCancellationRequested) {
                int length, key, state; uint width, height;
                lock(gate) {
                    if(handle == 0) return;
                    state = Native.od_video_state(handle, out width, out height);
                    length = Native.od_video_take(handle, pixels, pixels.Length, out key);
                }
                if(state < 0) throw new InvalidOperationException("Capture/encoder failed");
                if(length > 0) {
                    // v1: generation u64, timestamp(us) u64, width/height u32,
                    // key flag u32, payload length u32; all little-endian.
                    var packet = new byte[32 + length];
                    BinaryPrimitives.WriteUInt64LittleEndian(packet, Generation);
                    BinaryPrimitives.WriteUInt64LittleEndian(packet.AsSpan(8), (ulong)(clock.Elapsed.TotalMilliseconds * 1000));
                    BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(16), width);
                    BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(20), height);
                    BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(24), (uint)key);
                    BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(28), (uint)length);
                    pixels.AsSpan(0,length).CopyTo(packet.AsSpan(32));
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    deadline.CancelAfter(TimeSpan.FromSeconds(2)); // Bound stale video without treating a brief Wi-Fi stall as a disconnect.
                    try {
                        await socket.SendAsync(packet, WebSocketMessageType.Binary, true, deadline.Token);
                    } catch (OperationCanceledException) when (!ct.IsCancellationRequested) {
                        throw new TimeoutException("Video client stopped accepting frames for 2 seconds");
                    }
                } else await Task.Delay(5, ct);
                if(state == 1 && clock.Elapsed > TimeSpan.FromSeconds(10)) throw new InvalidOperationException("Video startup timeout");
            }
        } finally { socket.Abort(); }
    }
    public void Dispose()
    {
        Cancel();
        ReleaseNative();
    }
    void ReleaseNative()
    {
        lock(gate) {
            // This lock is not the input gate. Serialize multiple cleanup callers
            // so VDD removal cannot overtake the capture worker join.
            if(handle != 0) { Native.od_video_destroy(handle); handle=0; }
            if(virtualDisplay != 0) { Native.od_extend_destroy(virtualDisplay); virtualDisplay=0; }
        }
        // CTS intentionally remains readable by an in-flight Stream until GC.
    }
}
