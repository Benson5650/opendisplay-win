# OpenDisplay Web for Windows — development status

This fork is a work in progress. Pen Tablet, Mirror, and Extend have an HTTPS/WSS
host and PWA. Actual browser visual and iPad/Pencil acceptance remains
pending. The installed native application is not replaced by development builds.

## Implemented foundation

- Read-only `opendisplay-list-displays` enumerates active DisplayConfig monitor
  paths, names, current GDI capture names and physical bounds. Device paths are
  identity hints, not guaranteed eternal IDs; absent targets require reselection.
- Pure CSS-surface-to-target mapping with centered aspect preservation or stretch.
- Transport-independent PenTabletSession: explicit target selection, generation
  and sequence checks, cancellation, active-area exit, target removal/geometry
  changes, and a two-second heartbeat timeout. No video/VDD objects are used.
- Native injector teardown now releases finger-as-mouse drags as well as pen.

Build with Visual Studio 2026 and CMake:

```powershell
cmake -S . -B build -G "Visual Studio 18 2026" -A x64
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
build/Release/opendisplay-list-displays.exe
```

## Required integration contracts

The core is single-thread-owned. Resolver callbacks return null on missing or
unavailable displays; callbacks must not throw. Call Tick from a host timer at
least every 100ms, independently of incoming messages. An authenticated peer
sends heartbeats every 500ms. A new session returns its generation; sample
sequences start at 1. Resizing the drawable CSS area requires a new session.
Never forward predicted points. A release callback must release both pen and
mouse state. Capture teardown must precede VDD removal. Do not queue input across
mode switches or automatically redirect input after a target disappears.

## Next milestones (not implemented)

1. Validate the implemented Kestrel HTTPS/WSS host, C++ bridge, and Pencil-only
   PWA on iPad hardware. No capture/encoder/VDD initialization in Pen Tablet mode.
2. Add durable per-device credentials and individual revocation. Current preview
   pairing is intentionally memory-only and must repeat after a host restart.
3. Validate Mirror in a real browser: explicit display selection, complete H.264
   access units, WebCodecs, bounded queues, IDR recovery and letterbox mapping are
   implemented. Loopback integration verifies actual capture and H.264 transport,
   not visual decoding quality or Pencil alignment.
4. Extend is connected through existing Parsec VDD. Loopback tests create a
   registered 2360x1640 monitor, receive H.264, then verify restoration of the
   original active-display identities. Native pv3 runtime regression remains.

Web connections use an explicit IP, never .local/mDNS. The TLS certificate must
contain the chosen IP in SAN. An IP change requires certificate reissuance and
possibly new PWA origin/pairing; recommend DHCP reservation. No CA/certificates,
firewall rules or network listeners are installed by this foundation.
Existing upstream native Bonjour naming is unchanged, not a web dependency.

## Run the Pen Tablet preview

Requires .NET 10 SDK (build) and ASP.NET Core runtime 10 (run), in addition to the
C++ build tools. Build native Release first, then:

```powershell
dotnet build web-host/OpenDisplay.Web.csproj -c Release
# Substitute the Windows host's actual LAN IP, NOT the iPad IP.
./tools/New-WebCertificate.ps1 -Ip 192.168.8.231
cd web-host
dotnet bin/Release/net10.0-windows/OpenDisplay.Web.dll --ip 192.168.8.231 --cert ../host-data/host.pfx --dry-run true
```

The generator creates a one-host CA and leaf with IP SAN. It discards the CA
private key and does not install trust on Windows or iPad. The PFX private key is
restricted to the current Windows user; never copy it to iPad. Transfer only
`ipad-trust.cer`, verify its printed SHA256 fingerprint using a trusted channel,
and manually install/enable full trust on iPad. Renewal currently requires a new
CA and manual trust setup (remove the old profile). Certificate lifetime: 3 months.
Do not bypass a certificate warning. No unauthenticated HTTP bootstrap is served.

Open `https://<Windows-IP>:9443` on iPad. Enter the displayed pairing code, then
type `approve` into the host console. Codes expire after five minutes and are
single-use. `pair` generates a new code; `revoke` invalidates all devices and stops
input; `quit` shuts down. Auth is an HttpOnly/Secure/SameSite=Strict session cookie.
Only one control connection owns the native handle at a time. Restart the host
without `--dry-run true` only when ready to test actual Windows Ink input.

No firewall exception is added automatically. If needed, authorize only this
application/port on your trusted private LAN. The host binds only the given IP.
Do not expose it to the Internet. The preview remains a console application,
without persistent pairing, QR code, tray integration, or an installer.

The native core uses serialized bridge calls. A 100ms timer stops input on target
loss/geometry change or a two-second silence; PWA sends 500ms heartbeats. Entering
background, resizing, pointer cancellation and losing capture terminate strokes.
Coalesced actual events are sent; predicted events and finger input are not.

Automated integration (no desktop input; CA validation stays enabled):

```powershell
./tools/New-WebCertificate.ps1 -Ip 127.0.0.1 -Destination ./host-data-test
$env:NODE_EXTRA_CA_CERTS = (Resolve-Path ./host-data-test/ipad-trust.pem).Path
node tests/web_host_test.mjs
```

Set `OD_TEST_MIRROR=1` to additionally capture the first active display over
loopback (memory only, no saved frames) and check the video ticket, IDR/SPS,
geometry, keyframe request, and ticket invalidation. Input remains dry-run.
Run `node tests/video_packet_test.mjs` and `node tests/video_receiver_test.mjs`
for packet and simulated decoder lifecycle tests. These do not prove Safari
hardware decoding. Mirror currently preserves aspect ratio and captures native
resolution at 30/60 FPS; unsupported codec/size fails rather than silently
changing the target. Resolution scaling and HDR handling remain pending.

Re-use the test certificates on subsequent runs. The test creates and shuts down
a loopback-only dry-run host and exercises actual TLS, WSS and native mapping.

Hardware acceptance remains pending: mixed-DPI/negative-origin displays, iPad
orientation and app backgrounding, actual Pencil pressure/tilt/hover capabilities,
Windows Ink apps, and recovery without stuck input. Core tests use a fake sink:
they do not inject input into the user's desktop or prove device compatibility.

## Extend prerequisites and verification

The PWA accepts explicit even panel dimensions (width 640–4096, height 480–4096).
It does not infer native panel resolution from CSS viewport/DPR. The web host
never elevates or registers display modes. If a size is unavailable, register it
locally with the native executable's `--register-resolution <width> <height>`
command using administrator approval. Keep the web host un-elevated.

`OD_TEST_EXTEND=1` runs the integration test against the existing registered
2360x1640 mode. This temporarily changes desktop topology; do not run while a
critical display task is active. Current observed result: 31 integration checks
passed, including IDR/SPS, geometry and restored original active displays.
`OD_TEST_MIRROR=1` observed 30 checks passed. Both use dry-run input, trusted TLS,
and loopback video only. Neither test validates Safari rendering or pen accuracy.

Unfinished product features remain explicitly out of the current preview:
durable pairing/individual revocation, QR onboarding, tray UI, optional finger
mouse input, resolution scaling/quality presets, automatic rotation restart,
display-identify overlay and installer packaging. Do not call this a finished V1.
