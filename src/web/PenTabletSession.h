#pragma once

#include "CoordinateMapper.h"
#include <chrono>
#include <cstdint>
#include <functional>
#include <string>
#include <utility>

namespace od::web {
struct Target {
    std::wstring id;
    long left{}, top{}, width{}, height{};
    bool operator==(const Target&) const = default;
};
enum class Phase { Down, Move, Up, Hover, Cancel };
struct Sample {
    uint64_t generation{}, sequence{};
    Phase phase{};
    Point position{};
    double pressure{}, azimuth{}, altitude{};
    bool touch = false;
};
enum class SessionState { Idle, Active, TargetGone, MappingChanged, TimedOut };

// Single-thread-owned core. A future authenticated transport supplies events;
// no capture, encoder, network listener or virtual display is constructed here.
class PenTabletSession {
public:
    using Clock = std::chrono::steady_clock;
    using Resolve = std::function<std::optional<Target>(const std::wstring&)>;
    using Emit = std::function<void(const Target&, const Sample&)>;
    using Release = std::function<void()>;

    PenTabletSession(Resolve resolve, Emit emit, Release release)
        : resolve_(std::move(resolve)), emit_(std::move(emit)), release_(std::move(release)) {}
    ~PenTabletSession() { Stop(); }
    PenTabletSession(const PenTabletSession&) = delete;
    PenTabletSession& operator=(const PenTabletSession&) = delete;

    bool Start(const std::wstring& id, Size surface, Mapping mapping, Clock::time_point now,
               NormalizedRegion region = {}, bool lockRegionAspect = false)
    {
        Stop(); // Release old contact before changing its destination.
        if (id.empty()) return false; // Never guess the primary display.
        auto target = resolve_(id);
        if (!target || target->id != id || target->width <= 0 || target->height <= 0 || !ValidRegion(region) ||
            !MapPoint({surface.width / 2, surface.height / 2}, surface,
                      {double(target->width), double(target->height)}, mapping)) return false;
        target_ = *target;
        surface_ = surface;
        mapping_ = mapping;
        region_ = lockRegionAspect ? FitRegionAspect(
            region, (surface.width / surface.height) /
                (double(target->width) / double(target->height))) : region;
        lastSequence_ = 0;
        lastSeen_ = now;
        state_ = SessionState::Active;
        return true;
    }

    void Stop(SessionState reason = SessionState::Idle)
    {
        if (state_ == SessionState::Active) release_();
        down_ = false;
        state_ = reason;
        ++generation_; // Reconnect/resize/switch invalidates queued events.
    }

    // Host timer must call Tick even when the peer is silent (e.g. every 100ms).
    void Tick(Clock::time_point now)
    {
        if (state_ != SessionState::Active) return;
        auto target = resolve_(target_.id);
        if (!target) { Stop(SessionState::TargetGone); return; }
        if (*target != target_) { Stop(SessionState::MappingChanged); return; }
        if (now - lastSeen_ >= std::chrono::seconds(2)) Stop(SessionState::TimedOut);
    }

    bool Heartbeat(uint64_t generation, Clock::time_point now)
    {
        Tick(now);
        if (state_ != SessionState::Active || generation != generation_) return false;
        lastSeen_ = now;
        return true;
    }

    // Trackpad and multi-touch share the same generation, ordering, target and
    // heartbeat contract as pen samples, but keep their own contact state.
    bool AcceptAuxiliary(uint64_t generation, uint64_t sequence, Clock::time_point now)
    {
        Tick(now);
        if (state_ != SessionState::Active || generation != generation_ ||
            sequence <= lastSequence_) return false;
        lastSequence_ = sequence;
        lastSeen_ = now;
        return true;
    }

    std::optional<Point> MapInput(Point point) const
    {
        if (state_ != SessionState::Active) return std::nullopt;
        return ApplyRegion(MapPoint(point, surface_, {double(target_.width), double(target_.height)}, mapping_), region_);
    }

    const Target& CurrentTarget() const { return target_; }

    bool UpdateRegion(uint64_t generation, NormalizedRegion region, bool lockAspect)
    {
        if (state_ != SessionState::Active || generation != generation_ || !ValidRegion(region))
            return false;
        if (lockAspect) region = FitRegionAspect(
            region, (surface_.width / surface_.height) /
                (double(target_.width) / double(target_.height)));
        release_();
        down_ = false;
        region_ = region;
        return true;
    }

    NormalizedRegion CurrentRegion() const { return region_; }

    bool Handle(Sample sample, Clock::time_point now)
    {
        Tick(now);
        if (state_ != SessionState::Active || sample.generation != generation_ ||
            sample.sequence <= lastSequence_) return false;
        if (!std::isfinite(sample.pressure) || sample.pressure < 0 || sample.pressure > 1 ||
            !std::isfinite(sample.azimuth) || !std::isfinite(sample.altitude) ||
            sample.azimuth < 0 || sample.azimuth > 6.283185307179586 ||
            sample.altitude < 0 || sample.altitude > 1.570796326794897) return false;
        lastSequence_ = sample.sequence;
        lastSeen_ = now;
        if (sample.touch != touch_ && sample.phase != Phase::Down && sample.phase != Phase::Hover)
            return false; // Late up/move/cancel from another device cannot cancel a stroke.
        if (sample.phase == Phase::Cancel) { release_(); down_ = false; return true; }
        if (sample.touch != touch_) {
            release_(); down_ = false; touch_ = sample.touch;
        }
        auto point = ApplyRegion(MapPoint(sample.position, surface_,
            {double(target_.width), double(target_.height)}, mapping_), region_);
        if (!point) { release_(); down_ = false; return false; }
        switch (sample.phase) {
        case Phase::Down:
            if (down_) return false;
            down_ = true;
            break;
        case Phase::Move:
            if (!down_) return false; // No fresh stroke on reentering an active area.
            break;
        case Phase::Up:
            if (!down_) return false;
            down_ = false;
            sample.pressure = 0;
            break;
        case Phase::Hover:
            if (down_) release_();
            down_ = false;
            sample.pressure = 0;
            break;
        default: return false;
        }
        sample.position = *point;
        emit_(target_, sample);
        return true;
    }

    uint64_t Generation() const { return generation_; }
    SessionState State() const { return state_; }

private:
    Resolve resolve_;
    Emit emit_;
    Release release_;
    Target target_;
    Size surface_{};
    Mapping mapping_{};
    NormalizedRegion region_{};
    SessionState state_ = SessionState::Idle;
    uint64_t generation_ = 0, lastSequence_ = 0;
    Clock::time_point lastSeen_{};
    bool down_ = false;
    bool touch_ = false;
};
} // namespace od::web
