#include "PenTabletSession.h"
#include "display/DisplayCatalog.h"
#include "input/InputInjector.h"
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
        }, [this] { if (!dryRun) injector.EndSession(); }) {}
};
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
