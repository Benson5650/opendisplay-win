#include "input/InputInjector.h"
#include "input/InputMath.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace od {

namespace {

constexpr double kPixelsPerWheelNotch = 100.0; // heuristic; not specified by the wire protocol
constexpr UINT32 kPenPointerId = 1;
constexpr double kMaxPenPressure = 1024.0; // POINTER_PEN_INFO.pressure range
constexpr double kRadToDeg = 57.295779513082320876798; // 180/pi

// UIKit's spherical pen angles -> the tilt pair Windows wants (degrees,
// -90..90), using the W3C Pointer Events conversion. The macOS injector's
// formula is deliberately *not* reused: CGEvent tilt fields are normalized
// to -1..1, POINTER_PEN_INFO is in degrees.
void DeriveTilt(double azimuth, double altitude, INT32& tiltX, INT32& tiltY)
{
    double sinAlt = std::sin(altitude);
    double cosAlt = std::cos(altitude);
    double x = std::atan2(cosAlt * std::cos(azimuth), sinAlt) * kRadToDeg;
    double y = std::atan2(cosAlt * std::sin(azimuth), sinAlt) * kRadToDeg;
    tiltX = static_cast<INT32>(std::lround(std::clamp(x, -90.0, 90.0)));
    tiltY = static_cast<INT32>(std::lround(std::clamp(y, -90.0, 90.0)));
}

static void EnsureDefaultDesktop()
{
    HDESK hDesk = OpenDesktopW(L"default", 0, FALSE, GENERIC_ALL);
    if (hDesk) {
        SetThreadDesktop(hDesk);
        CloseDesktop(hDesk);
    }
}

bool SendMouseInput(DWORD flags, LONG dx = 0, LONG dy = 0, LONG mouseData = 0)
{
    EnsureDefaultDesktop();
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dx = dx;
    input.mi.dy = dy;
    input.mi.mouseData = mouseData;
    input.mi.dwFlags = flags;
    return SendInput(1, &input, sizeof(INPUT)) == 1;
}

} // namespace

void InputInjector::HandleTouch(const TouchMsg& touch)
{
    LONG screenX = monitorRect_.left + static_cast<LONG>(touch.x * (monitorRect_.right - monitorRect_.left));
    LONG screenY = monitorRect_.top + static_cast<LONG>(touch.y * (monitorRect_.bottom - monitorRect_.top));

    LONG normX = NormalizeAbsoluteCoordinate(screenX, GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN));
    LONG normY = NormalizeAbsoluteCoordinate(screenY, GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));

    DWORD moveFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;

    switch (touch.phase) {
        case TouchPhase::Began:
            SendMouseInput(moveFlags, normX, normY);
            SendMouseInput(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, normX, normY);
            leftMouseDown_ = true;
            break;
        case TouchPhase::Moved:
            SendMouseInput(moveFlags, normX, normY);
            break;
        case TouchPhase::Ended:
        case TouchPhase::Cancelled:
            SendMouseInput(moveFlags, normX, normY);
            if (leftMouseDown_)
                SendMouseInput(MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, normX, normY);
            leftMouseDown_ = false;
            break;
        default:
            break;
    }
}

bool InputInjector::HandleTrackpadMove(double dx, double dy)
{
    if (!std::isfinite(dx) || !std::isfinite(dy)) return false;
    POINT cursor{};
    if (!GetCursorPos(&cursor)) return false;
    const LONG minX = monitorRect_.left;
    const LONG minY = monitorRect_.top;
    const LONG maxX = std::max(minX, monitorRect_.right - 1);
    const LONG maxY = std::max(minY, monitorRect_.bottom - 1);
    const LONG baseX = std::clamp(cursor.x, minX, maxX);
    const LONG baseY = std::clamp(cursor.y, minY, maxY);
    const double totalX = dx + mouseRemainderX_;
    const double totalY = dy + mouseRemainderY_;
    const LONG stepX = static_cast<LONG>(std::trunc(totalX));
    const LONG stepY = static_cast<LONG>(std::trunc(totalY));
    mouseRemainderX_ = totalX - stepX;
    mouseRemainderY_ = totalY - stepY;
    const LONG screenX = std::clamp<LONG>(baseX + stepX, minX, maxX);
    const LONG screenY = std::clamp<LONG>(baseY + stepY, minY, maxY);
    if ((screenX == minX && stepX < 0) || (screenX == maxX && stepX > 0)) mouseRemainderX_ = 0;
    if ((screenY == minY && stepY < 0) || (screenY == maxY && stepY > 0)) mouseRemainderY_ = 0;
    const LONG normX = NormalizeAbsoluteCoordinate(screenX, GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN));
    const LONG normY = NormalizeAbsoluteCoordinate(screenY, GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
    return SendMouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, normX, normY);
}

bool InputInjector::HandleMouseButton(bool right, bool down)
{
    bool& state = right ? rightMouseDown_ : leftMouseDown_;
    if (state == down) return false;
    const DWORD flags = right ? (down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP)
                              : (down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP);
    if (!SendMouseInput(flags)) return false;
    state = down;
    return true;
}

void InputInjector::HandleScroll(const ScrollMsg& scroll)
{
    if (scroll.dy != 0.0) {
        wheelRemainderY_ += (scroll.dy / kPixelsPerWheelNotch) * WHEEL_DELTA;
        LONG delta = static_cast<LONG>(std::trunc(wheelRemainderY_));
        if (delta != 0)
            SendMouseInput(MOUSEEVENTF_WHEEL, 0, 0, delta);
        wheelRemainderY_ -= delta;
    }
    if (scroll.dx != 0.0) {
        wheelRemainderX_ += (scroll.dx / kPixelsPerWheelNotch) * WHEEL_DELTA;
        LONG delta = static_cast<LONG>(std::trunc(wheelRemainderX_));
        if (delta != 0)
            SendMouseInput(MOUSEEVENTF_HWHEEL, 0, 0, delta);
        wheelRemainderX_ -= delta;
    }
}

InputInjector::~InputInjector()
{
    EndSession();
    if (touchDevice_ != nullptr)
        DestroySyntheticPointerDevice(touchDevice_);
    if (penDevice_ != nullptr)
        DestroySyntheticPointerDevice(penDevice_);
}

POINT InputInjector::ScreenPoint(double nx, double ny) const
{
    // Pen injection takes physical pixels relative to the *top-left of the
    // virtual screen*, not SendInput's 0..65535 space and not raw desktop
    // coordinates: MonitorRect() is GetMonitorInfo's rcMonitor, so a monitor
    // left of or above the primary is negative there, and Windows drops such
    // frames without an error (InjectSyntheticPointerInput still returns TRUE).
    // Hence the same origin shift HandleTouch does inside its normalization.
    POINT pt;
    pt.x = monitorRect_.left + std::lround(nx * (monitorRect_.right - monitorRect_.left)) -
           GetSystemMetrics(SM_XVIRTUALSCREEN);
    pt.y = monitorRect_.top + std::lround(ny * (monitorRect_.bottom - monitorRect_.top)) -
           GetSystemMetrics(SM_YVIRTUALSCREEN);
    return pt;
}

bool InputInjector::EnsurePenDevice()
{
    EnsureDefaultDesktop();
    if (penDevice_ != nullptr)
        return true;
    if (penDeviceFailed_)
        return false;

    POINTER_FEEDBACK_MODE feedback = showCursor_ ? POINTER_FEEDBACK_DEFAULT : POINTER_FEEDBACK_NONE;
    penDevice_ = CreateSyntheticPointerDevice(PT_PEN, 1, feedback);
    if (penDevice_ == nullptr) {
        // Pre-1809 Windows, or the slot is taken. Give up for this session
        // rather than hammering the API once per pen sample; finger touch is
        // unaffected and the pen still moves the cursor as plain touch.
        fprintf(stderr, "CreateSyntheticPointerDevice(PT_PEN) failed: %lu\n", GetLastError());
        penDeviceFailed_ = true;
        return false;
    }
    return true;
}

void InputInjector::SetCursorFeedback(bool showCursor)
{
    if (showCursor_ == showCursor) return;
    showCursor_ = showCursor;
    if (penDevice_ != nullptr) {
        ReleasePenIfDown(lastPenPoint_);
        DestroySyntheticPointerDevice(penDevice_);
        penDevice_ = nullptr;
        penDeviceFailed_ = false;
        EnsurePenDevice();
    }
}

bool InputInjector::EnsureTouchDevice()
{
    EnsureDefaultDesktop();
    if (touchDevice_ != nullptr) return true;
    if (touchDeviceFailed_) return false;
    touchDevice_ = CreateSyntheticPointerDevice(PT_TOUCH,
        static_cast<ULONG>(web::DirectTouchState::MaxContacts), POINTER_FEEDBACK_DEFAULT);
    if (touchDevice_ == nullptr) {
        fprintf(stderr, "CreateSyntheticPointerDevice(PT_TOUCH) failed: %lu\n", GetLastError());
        touchDeviceFailed_ = true;
        return false;
    }
    return true;
}

bool InputInjector::InjectTouchFrame(const std::vector<web::DirectTouchContact>& frame)
{
    EnsureDefaultDesktop();
    if (frame.empty()) return true;
    if (!EnsureTouchDevice()) return false;
    std::vector<POINTER_TYPE_INFO> infos(frame.size());
    for (size_t i = 0; i < frame.size(); ++i) {
        const auto& source = frame[i];
        auto& info = infos[i];
        info.type = PT_TOUCH;
        auto& touch = info.touchInfo;
        touch.pointerInfo.pointerType = PT_TOUCH;
        touch.pointerInfo.pointerId = source.pointerId;
        const POINT point = ScreenPoint(source.position.x, source.position.y);
        touch.pointerInfo.ptPixelLocation = point;
        switch (source.change) {
            case web::DirectTouchChange::Down:
                touch.pointerInfo.pointerFlags = POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT |
                    POINTER_FLAG_DOWN | POINTER_FLAG_CONFIDENCE;
                break;
            case web::DirectTouchChange::Update:
                touch.pointerInfo.pointerFlags = POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT |
                    POINTER_FLAG_UPDATE | POINTER_FLAG_CONFIDENCE;
                break;
            case web::DirectTouchChange::Up:
                touch.pointerInfo.pointerFlags = POINTER_FLAG_UP;
                break;
            case web::DirectTouchChange::Cancel:
                touch.pointerInfo.pointerFlags = POINTER_FLAG_UP | POINTER_FLAG_CANCELED;
                break;
        }
        touch.touchFlags = TOUCH_FLAG_NONE;
        touch.touchMask = TOUCH_MASK_CONTACTAREA | TOUCH_MASK_ORIENTATION | TOUCH_MASK_PRESSURE;
        touch.orientation = 90;
        touch.pressure = 32000;
        touch.rcContact = {point.x - 2, point.y - 2, point.x + 2, point.y + 2};
    }
    if (!InjectSyntheticPointerInput(touchDevice_, infos.data(), static_cast<UINT32>(infos.size()))) {
        if (!touchInjectFailed_) {
            touchInjectFailed_ = true;
            fprintf(stderr, "InjectSyntheticPointerInput(PT_TOUCH) failed: %lu\n", GetLastError());
        }
        return false;
    }
    return true;
}

bool InputInjector::HandleDirectTouch(uint32_t sourceId, web::DirectTouchPhase phase,
                                      std::optional<web::Point> normalizedPosition)
{
    auto frame = directTouches_.Apply(sourceId, phase, normalizedPosition);
    return frame && InjectTouchFrame(*frame);
}

bool InputInjector::RefreshDirectTouches()
{
    return InjectTouchFrame(directTouches_.Updates());
}

void InputInjector::InjectPen(UINT32 flags, POINT pt, double pressure, double azimuth, double altitude)
{
    EnsureDefaultDesktop();
    lastPenPoint_ = pt;

    POINTER_TYPE_INFO info{};
    info.type = PT_PEN;
    info.penInfo.pointerInfo.pointerType = PT_PEN;
    info.penInfo.pointerInfo.pointerId = kPenPointerId;
    info.penInfo.pointerInfo.ptPixelLocation = pt;
    info.penInfo.pointerInfo.pointerFlags = flags;
    info.penInfo.penFlags = PEN_FLAG_NONE;
    info.penInfo.penMask = PEN_MASK_PRESSURE | PEN_MASK_TILT_X | PEN_MASK_TILT_Y;
    info.penInfo.pressure =
        static_cast<UINT32>(std::lround(std::clamp(pressure, 0.0, 1.0) * kMaxPenPressure));
    DeriveTilt(azimuth, altitude, info.penInfo.tiltX, info.penInfo.tiltY);

    if (!InjectSyntheticPointerInput(penDevice_, &info, 1) && !injectFailed_) {
        injectFailed_ = true; // one line, not one per sample
        fprintf(stderr, "InjectSyntheticPointerInput failed: %lu (flags=0x%08X, pt=%ld,%ld)\n",
                GetLastError(), flags, pt.x, pt.y);
    }
}

void InputInjector::ReleasePenIfDown(POINT pt)
{
    if (!penDown_)
        return;
    InjectPen(POINTER_FLAG_INRANGE | POINTER_FLAG_UP, pt, 0.0, 0.0, kPencilAltitudeUpright);
    penDown_ = false;
}

void InputInjector::HandlePencil(const PencilMsg& pencil)
{
    if (!EnsurePenDevice())
        return;

    const POINT pt = ScreenPoint(pencil.x, pencil.y);

    switch (pencil.phase) {
        case PencilPhase::Down:
            InjectPen(POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT | POINTER_FLAG_DOWN, pt,
                      pencil.pressure, pencil.azimuth, pencil.altitude);
            penDown_ = true;
            penInRange_ = true;
            break;
        case PencilPhase::Move:
            if (penDown_) {
                InjectPen(POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT | POINTER_FLAG_UPDATE, pt,
                          pencil.pressure, pencil.azimuth, pencil.altitude);
            } else {
                InjectPen(POINTER_FLAG_INRANGE | POINTER_FLAG_UPDATE, pt, 0.0, pencil.azimuth,
                          pencil.altitude);
            }
            penInRange_ = true;
            break;
        case PencilPhase::Up:
            ReleasePenIfDown(pt);
            break;
        case PencilPhase::Hover:
            // A stroke that ran off the panel edge comes back as hover while we
            // still hold the pen down — release it first, or the button stays
            // stuck (same recovery as the macOS injector).
            ReleasePenIfDown(pt);
            InjectPen(POINTER_FLAG_INRANGE | POINTER_FLAG_UPDATE, pt, 0.0, pencil.azimuth,
                      pencil.altitude);
            penInRange_ = true;
            break;
        default:
            break;
    }
}

void InputInjector::EndSession()
{
    EndFingerSession();
    if (penDevice_ == nullptr)
        return;

    ReleasePenIfDown(lastPenPoint_);
    if (penInRange_) {
        // No INRANGE flag: tells Windows the pen left hover range for good.
        InjectPen(POINTER_FLAG_UPDATE, lastPenPoint_, 0.0, 0.0, kPencilAltitudeUpright);
        penInRange_ = false;
    }
}

void InputInjector::EndFingerSession()
{
    // Mouse buttons and synthetic touch contacts must never survive a peer.
    if (leftMouseDown_) {
        SendMouseInput(MOUSEEVENTF_LEFTUP);
        leftMouseDown_ = false;
    }
    if (rightMouseDown_) {
        SendMouseInput(MOUSEEVENTF_RIGHTUP);
        rightMouseDown_ = false;
    }
    InjectTouchFrame(directTouches_.CancelAll());
    mouseRemainderX_ = mouseRemainderY_ = 0;
    wheelRemainderX_ = wheelRemainderY_ = 0;
}

void InputInjector::HandleProximity(const ProximityMsg& proximity)
{
    if (!EnsurePenDevice())
        return;
    if (proximity.entering == penInRange_)
        return;

    const POINT pt = ScreenPoint(proximity.x, proximity.y);

    if (proximity.entering) {
        InjectPen(POINTER_FLAG_INRANGE | POINTER_FLAG_UPDATE, pt, 0.0, 0.0, kPencilAltitudeUpright);
    } else {
        ReleasePenIfDown(pt);
        // No INRANGE: that is what tells Windows the pen left hover range.
        InjectPen(POINTER_FLAG_UPDATE, pt, 0.0, 0.0, kPencilAltitudeUpright);
    }
    penInRange_ = proximity.entering;
}

} // namespace od
