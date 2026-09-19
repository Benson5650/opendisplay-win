# OpenDisplay Web for Windows — development status

This fork is a work in progress, not a working web receiver yet. The installed
native application is not replaced by development builds.

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

1. Wire the core to InputInjector and an authenticated HTTPS/WSS host; serve a
   Pencil-only PWA. No capture/encoder/VDD initialization in Pen Tablet mode.
2. Pair through a short-lived code and local host confirmation; bind both sockets
   to one authenticated session, validate Origin, support revocation. Remain
   un-elevated; no arbitrary remote commands or automatic firewall broadening.
3. Mirror the explicitly selected display; add WebCodecs capability negotiation,
   complete H.264 access units, bounded queues, IDR recovery and letterbox mapping.
4. Add Extend via existing Parsec VDD and regression-test native pv3 transport.

Web connections use an explicit IP, never .local/mDNS. The TLS certificate must
contain the chosen IP in SAN. An IP change requires certificate reissuance and
possibly new PWA origin/pairing; recommend DHCP reservation. No CA/certificates,
firewall rules or network listeners are installed by this foundation.
Existing upstream native Bonjour naming is unchanged, not a web dependency.

Hardware acceptance remains pending: mixed-DPI/negative-origin displays, iPad
orientation and app backgrounding, actual Pencil pressure/tilt/hover capabilities,
Windows Ink apps, and recovery without stuck input. Core tests use a fake sink:
they do not inject input into the user's desktop or prove device compatibility.
