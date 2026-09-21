#include "PenTabletSession.h"
#include "VideoPipeline.h"
#include "display/VirtualDisplay.h"
#include "display/DisplayCatalog.h"
#include "input/InputInjector.h"
#include <cmath>
#include <memory>
#include <sstream>

#define API extern "C" __declspec(dllexport)
namespace {
std::wstring Escape(const std::wstring& value)
{
    std::wstring out;
    for (wchar_t c : value) {
        if (c == L'\\' || c == L'"') out += L'\\';
        if (c >= 32) out += c;
    }
    return out;
}
struct Bridge {
    od::InputInjector injector;
    bool dryRun;
    uint64_t emitted = 0;
    od::web::DirectTouchState dryTouches;
    od::web::PenTabletSession session;
    explicit Bridge(bool dry) : dryRun(dry), session(
        [](const std::wstring& id) -> std::optional<od::web::Target> {
            try {
                for (const auto& d : od::EnumerateDisplays()) if (d.id == id)
                    return od::web::Target{d.id, d.bounds.left, d.bounds.top,
                        d.bounds.right - d.bounds.left, d.bounds.bottom - d.bounds.top};
            } catch (...) {}
            return std::nullopt;
        },
        [this](const od::web::Target& t, const od::web::Sample& s) {
            ++emitted;
            if (dryRun) return;
            injector.SetMonitorRect({t.left, t.top, t.left + t.width, t.top + t.height});
            if (s.touch) {
                od::TouchPhase touchPhase = od::TouchPhase::Unknown;
                switch(s.phase) {
                    case od::web::Phase::Down: touchPhase=od::TouchPhase::Began; break;
                    case od::web::Phase::Move: touchPhase=od::TouchPhase::Moved; break;
                    case od::web::Phase::Up: touchPhase=od::TouchPhase::Ended; break;
                    default: return;
                }
                injector.HandleTouch({touchPhase,s.position.x*(t.width-1.0)/t.width,s.position.y*(t.height-1.0)/t.height});
                return;
            }
            od::PencilPhase phase = od::PencilPhase::Unknown;
            switch (s.phase) {
                case od::web::Phase::Down: phase = od::PencilPhase::Down; break;
                case od::web::Phase::Move: phase = od::PencilPhase::Move; break;
                case od::web::Phase::Up: phase = od::PencilPhase::Up; break;
                case od::web::Phase::Hover: phase = od::PencilPhase::Hover; break;
                default: return;
            }
            // Normalized 1 must land on the last pixel, not the next monitor.
            const double x = s.position.x * (t.width - 1.0) / t.width;
            const double y = s.position.y * (t.height - 1.0) / t.height;
            injector.HandlePencil({phase, x, y, s.pressure, s.azimuth, s.altitude});
        }, [this] {
            dryTouches.CancelAll();
            if (!dryRun) injector.EndSession();
        }) {}
};

void SetTarget(Bridge& bridge, const od::web::Target& target)
{
    if (!bridge.dryRun)
        bridge.injector.SetMonitorRect({target.left, target.top,
            target.left + target.width, target.top + target.height});
}
}

// ABI v1. Host must serialize all access to each handle, including destroy.
API void* od_create(int dryRun) noexcept
{
    try { return new Bridge(dryRun != 0); } catch (...) { return nullptr; }
}
API void od_destroy(void* handle) noexcept { delete static_cast<Bridge*>(handle); }
API int od_displays(wchar_t* buffer, int capacity) noexcept
{
    try {
        std::wostringstream json;
        json << L"[";
        bool first = true;
        for (const auto& d : od::EnumerateDisplays()) {
            if (!first) json << L",";
            first = false;
            json << L"{\"id\":\"" << Escape(d.id) << L"\",\"name\":\"" << Escape(d.name)
                 << L"\",\"width\":" << d.bounds.right - d.bounds.left
                 << L",\"height\":" << d.bounds.bottom - d.bounds.top
                 << L",\"primary\":" << (d.primary ? L"true" : L"false") << L"}";
        }
        json << L"]";
        const auto value = json.str();
        if (!buffer || capacity <= int(value.size())) return -1;
        wcscpy_s(buffer, capacity, value.c_str());
        return 1;
    } catch (...) { return 0; }
}
API uint64_t od_start(void* handle, const wchar_t* id, double width, double height, int stretch) noexcept
{
    if (!handle || !id) return 0;
    try {
        auto& b = *static_cast<Bridge*>(handle);
        return b.session.Start(id, {width, height}, stretch ? od::web::Mapping::Stretch :
            od::web::Mapping::PreserveAspect, od::web::PenTabletSession::Clock::now()) ? b.session.Generation() : 0;
    } catch (...) { return 0; }
}
API uint64_t od_start_region(void* handle, const wchar_t* id, double width, double height, int stretch,
                             double x, double y, double regionWidth, double regionHeight) noexcept
{
    if (!handle || !id) return 0;
    try {
        auto& b = *static_cast<Bridge*>(handle);
        return b.session.Start(id, {width, height}, stretch ? od::web::Mapping::Stretch :
            od::web::Mapping::PreserveAspect, od::web::PenTabletSession::Clock::now(),
            {x, y, regionWidth, regionHeight}, stretch != 0) ? b.session.Generation() : 0;
    } catch (...) { return 0; }
}
API int od_tick(void* handle) noexcept
{
    if (!handle) return 0;
    auto& session = static_cast<Bridge*>(handle)->session;
    session.Tick(od::web::PenTabletSession::Clock::now());
    return int(session.State());
}
API void od_stop(void* handle) noexcept
{
    if (handle) static_cast<Bridge*>(handle)->session.Stop();
}
API int od_heartbeat(void* handle, uint64_t generation) noexcept
{
    return handle && static_cast<Bridge*>(handle)->session.Heartbeat(generation, od::web::PenTabletSession::Clock::now());
}
API int od_sample(void* handle, uint64_t generation, uint64_t sequence, int phase,
    double x, double y, double pressure, double azimuth, double altitude) noexcept
{
    if (!handle || phase < 0 || phase > 4) return 0;
    return static_cast<Bridge*>(handle)->session.Handle({generation, sequence, od::web::Phase(phase),
        {x, y}, pressure, azimuth, altitude}, od::web::PenTabletSession::Clock::now());
}
API uint64_t od_emitted(void* handle) noexcept
{
    return handle ? static_cast<Bridge*>(handle)->emitted : 0;
}
API int od_touch(void* handle, uint64_t generation, uint64_t sequence, int phase, double x, double y) noexcept
{
    if (!handle || phase < 0 || phase > 4 || phase == 3) return 0;
    return static_cast<Bridge*>(handle)->session.Handle({generation,sequence,od::web::Phase(phase),
        {x,y},0,0,1.5707963267948966,true},od::web::PenTabletSession::Clock::now());
}

// action: 0 move, 1/2 left down/up, 3/4 right down/up, 5 scroll.
API int od_trackpad(void* handle, uint64_t generation, uint64_t sequence,
                    int action, double x, double y) noexcept
{
    if (!handle || action < 0 || action > 5 || !std::isfinite(x) || !std::isfinite(y) ||
        std::abs(x) > 512 || std::abs(y) > 512) return 0;
    try {
        auto& bridge = *static_cast<Bridge*>(handle);
        if (!bridge.session.AcceptAuxiliary(generation, sequence, od::web::PenTabletSession::Clock::now())) return 0;
        SetTarget(bridge, bridge.session.CurrentTarget());
        if (bridge.dryRun) { ++bridge.emitted; return 1; }
        switch (action) {
            case 0: return bridge.injector.HandleTrackpadMove(x, y) ? 1 : 0;
            case 1: return bridge.injector.HandleMouseButton(false, true) ? 1 : 0;
            case 2: return bridge.injector.HandleMouseButton(false, false) ? 1 : 0;
            case 3: return bridge.injector.HandleMouseButton(true, true) ? 1 : 0;
            case 4: return bridge.injector.HandleMouseButton(true, false) ? 1 : 0;
            case 5: bridge.injector.HandleScroll({x, y}); return 1;
        }
    } catch (...) {}
    return 0;
}

// phase: 0 down, 1 move, 2 up, 3 cancel. Browser contact IDs are remapped
// internally to the stable 1..5 pointer IDs expected by Windows.
API int od_direct_touch(void* handle, uint64_t generation, uint64_t sequence,
                        uint32_t contactId, int phase, double x, double y) noexcept
{
    if (!handle || phase < 0 || phase > 3 || !std::isfinite(x) || !std::isfinite(y)) return 0;
    try {
        auto& bridge = *static_cast<Bridge*>(handle);
        if (!bridge.session.AcceptAuxiliary(generation, sequence, od::web::PenTabletSession::Clock::now())) return 0;
        const auto directPhase = static_cast<od::web::DirectTouchPhase>(phase);
        std::optional<od::web::Point> normalized;
        if (directPhase == od::web::DirectTouchPhase::Down || directPhase == od::web::DirectTouchPhase::Move) {
            auto mapped = bridge.session.MapInput({x, y});
            if (!mapped) {
                if (directPhase == od::web::DirectTouchPhase::Move) {
                    if (bridge.dryRun) bridge.dryTouches.Apply(contactId, od::web::DirectTouchPhase::Cancel, std::nullopt);
                    else bridge.injector.HandleDirectTouch(contactId, od::web::DirectTouchPhase::Cancel, std::nullopt);
                }
                return 0;
            }
            const auto& target = bridge.session.CurrentTarget();
            normalized = od::web::Point{
                mapped->x * (target.width - 1.0) / target.width,
                mapped->y * (target.height - 1.0) / target.height};
        }
        SetTarget(bridge, bridge.session.CurrentTarget());
        bool accepted;
        if (bridge.dryRun)
            accepted = bridge.dryTouches.Apply(contactId, directPhase, normalized).has_value();
        else
            accepted = bridge.injector.HandleDirectTouch(contactId, directPhase, normalized);
        if (accepted) ++bridge.emitted;
        return accepted ? 1 : 0;
    } catch (...) { return 0; }
}

API void od_cancel_finger(void* handle) noexcept
{
    if (!handle) return;
    auto& bridge = *static_cast<Bridge*>(handle);
    bridge.dryTouches.CancelAll();
    if (!bridge.dryRun) bridge.injector.EndFingerSession();
}

API int od_touch_refresh(void* handle) noexcept
{
    if (!handle) return 0;
    auto& bridge = *static_cast<Bridge*>(handle);
    if (bridge.dryRun) return 1;
    return bridge.injector.RefreshDirectTouches() ? 1 : 0;
}

API void od_set_cursor_feedback(void* handle, int showCursor) noexcept
{
    if (handle) static_cast<Bridge*>(handle)->injector.SetCursorFeedback(showCursor != 0);
}

API int od_identify_displays() noexcept
{
    try {
        od::IdentifyDisplays();
        return 1;
    } catch (...) {
        return 0;
    }
}

// Video handles are owned by one authenticated control session. Creation only
// accepts a catalog identity; a caller cannot pass an arbitrary GDI source name.
API void* od_video_create(const wchar_t* id, unsigned fps, unsigned bitrate, double scale = 1.0) noexcept
{
    if (!id || !*id || (fps != 30 && fps != 60) || bitrate < 4'000'000 || bitrate > 24'000'000) return nullptr;
    try {
        for (const auto& display : od::EnumerateDisplays()) {
            if (display.id != id) continue;
            auto video = std::make_unique<od::web::VideoPipeline>();
            video->Start(display.deviceName, fps, bitrate, scale);
            return video.release();
        }
    } catch (...) {}
    return nullptr;
}
API void od_video_destroy(void* handle) noexcept
{
    delete static_cast<od::web::VideoPipeline*>(handle);
}

// Caller owns this display until video capture is fully stopped and input is
// released. No automatic HKLM writes or UAC from a web request.
API void* od_extend_create(unsigned width, unsigned height, wchar_t* id, int capacity) noexcept
{
    if (!id || capacity < 2 || width < 640 || height < 480 || width > 4096 || height > 4096 || width % 2 || height % 2)
        return nullptr;
    try {
        auto display = std::make_unique<od::VirtualDisplay>();
        display->SetIdentity("web-extend");
        if (!display->Open() || !display->EnsureResolution(width, height, 60, false)) return nullptr;
        for (const auto& candidate : od::EnumerateDisplays()) {
            if (candidate.deviceName != display->DeviceName()) continue;
            if (candidate.id.size() >= static_cast<size_t>(capacity)) return nullptr;
            wcscpy_s(id, capacity, candidate.id.c_str());
            return display.release();
        }
    } catch (...) {}
    return nullptr;
}
API void od_extend_destroy(void* handle) noexcept
{
    delete static_cast<od::VirtualDisplay*>(handle);
}
API int od_video_state(void* handle, unsigned* width, unsigned* height) noexcept
{
    if (!handle || !width || !height) return -1;
    const auto& video = *static_cast<od::web::VideoPipeline*>(handle);
    *width = video.Width(); *height = video.Height();
    return video.State();
}
API void od_video_keyframe(void* handle) noexcept
{
    if (handle) static_cast<od::web::VideoPipeline*>(handle)->RequestKeyFrame();
}
// Returns access-unit length; 0 means no frame, -1 insufficient buffer.
// A discarded oversized access unit requests decoder recovery automatically.
API int od_video_take(void* handle, unsigned char* buffer, int capacity, int* key) noexcept
{
    if (!handle || !buffer || capacity <= 0 || !key) return -1;
    auto& video = *static_cast<od::web::VideoPipeline*>(handle);
    auto frame = video.Take();
    if (!frame) return 0;
    if (frame->annexB.size() > static_cast<size_t>(capacity)) {
        video.RequestKeyFrame(); return -1;
    }
    memcpy(buffer, frame->annexB.data(), frame->annexB.size());
    *key = frame->isKeyFrame ? 1 : 0;
    return static_cast<int>(frame->annexB.size());
}
