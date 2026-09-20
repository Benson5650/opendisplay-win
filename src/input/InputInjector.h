#pragma once

#include <windows.h>

#include "net/Protocol.h"
#include "web/FingerInputState.h"

namespace od {

// Maps receiver touch/scroll control messages to Win32 SendInput mouse
// events (spec §7d). Touch coordinates are normalized [0,1], origin
// top-left, relative to the video image — mapped to the virtual monitor's
// rect within the Windows virtual desktop, then to SendInput's 0..65535
// absolute space over the *entire* virtual desktop (SM_XVIRTUALSCREEN/
// SM_CXVIRTUALSCREEN — the classic multi-monitor absolute-coordinate pitfall).
// Apple Pencil takes a different route: a synthetic pen device
// (CreateSyntheticPointerDevice, Windows 10 1809+) fed with POINTER_PEN_INFO,
// which is what carries pressure, tilt and hover. Windows synthesizes the
// mouse messages for non-pointer-aware apps from it, so clicking UI still
// works; WinTab-only apps (older Photoshop setups) do not see it.
class InputInjector {
public:
    ~InputInjector();

    InputInjector() = default;
    InputInjector(const InputInjector&) = delete;
    InputInjector& operator=(const InputInjector&) = delete;

    // Rect of the virtual monitor within the Windows virtual desktop
    // (VirtualDisplay::MonitorRect()). Must be set before touches arrive;
    // update again on rotation (new hello -> new rect).
    void SetMonitorRect(const RECT& rect) { monitorRect_ = rect; }

    void HandleTouch(const TouchMsg& touch);
    bool HandleTrackpadMove(double dx, double dy);
    bool HandleMouseButton(bool right, bool down);
    void HandleScroll(const ScrollMsg& scroll);
    bool HandleDirectTouch(uint32_t sourceId, web::DirectTouchPhase phase,
                           std::optional<web::Point> normalizedPosition);
    void HandlePencil(const PencilMsg& pencil);
    void HandleProximity(const ProximityMsg& proximity);
    void EndFingerSession();

    // Call when a connection ends. The pen device outlives a reconnect, so a
    // link that drops mid-stroke would otherwise leave the injected pen in
    // contact — Windows keeps dragging until the pen happens to hover again.
    void EndSession();

private:
    POINT ScreenPoint(double nx, double ny) const;
    bool EnsurePenDevice();
    bool EnsureTouchDevice();
    void InjectPen(UINT32 flags, POINT pt, double pressure, double azimuth, double altitude);
    bool InjectTouchFrame(const std::vector<web::DirectTouchContact>& frame);
    void ReleasePenIfDown(POINT pt);

    RECT monitorRect_{};
    bool leftMouseDown_ = false;
    bool rightMouseDown_ = false;
    double mouseRemainderX_ = 0.0;
    double mouseRemainderY_ = 0.0;
    double wheelRemainderX_ = 0.0;
    double wheelRemainderY_ = 0.0;

    HSYNTHETICPOINTERDEVICE touchDevice_ = nullptr;
    bool touchDeviceFailed_ = false;
    bool touchInjectFailed_ = false;
    web::DirectTouchState directTouches_;

    HSYNTHETICPOINTERDEVICE penDevice_ = nullptr;
    bool penDeviceFailed_ = false; // creation failed once -> stop retrying per event
    bool injectFailed_ = false;    // log the first injection failure only
    bool penDown_ = false;
    bool penInRange_ = false;
    POINT lastPenPoint_{}; // where to release from if the link dies mid-stroke
};

} // namespace od
