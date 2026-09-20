#include "web/PenTabletSession.h"
#include "web/FingerInputState.h"
#include "input/InputMath.h"
#include <cstdlib>
#include <iostream>
#include <limits>

using namespace od::web;
static int checks = 0;
static void Check(bool condition, const char* label)
{
    ++checks;
    if (!condition) { std::cerr << "FAIL: " << label << '\n'; std::exit(1); }
}
int main()
{
    const Size surface{1000, 750}, targetSize{1600, 1000};
    auto center = MapPoint({500, 375}, surface, targetSize, Mapping::PreserveAspect);
    Check(center && center->x == .5 && center->y == .5, "center");
    Check(!MapPoint({500, 20}, surface, targetSize, Mapping::PreserveAspect), "letterbox");
    auto corner = MapPoint({0, 62.5}, surface, targetSize, Mapping::PreserveAspect);
    Check(corner && corner->x == 0 && corner->y == 0, "active corner");
    Check(MapPoint({1000, 750}, surface, targetSize, Mapping::Stretch).has_value(), "stretch edge");
    Check(!MapPoint({0, 0}, {0, 1}, targetSize, Mapping::Stretch), "zero surface");
    Check(!MapPoint({std::numeric_limits<double>::quiet_NaN(), 0}, surface, targetSize,
                   Mapping::Stretch), "NaN rejected");
    Check(!MapPoint({0, 0}, surface, {1, std::numeric_limits<double>::infinity()},
                   Mapping::PreserveAspect), "infinite size rejected");
    for(long extent : {1920L,3840L}) for(long pixel=0;pixel<extent;++pixel) {
        const auto normalized=od::NormalizeAbsoluteCoordinate(pixel-1920,-1920,extent);
        Check((static_cast<int64_t>(normalized)*extent)/65536==pixel,
              "absolute mouse pixel round-trip has no left drift");
    }
    int emitted = 0, released = 0;
    std::optional<Target> display = Target{L"monitor-path", -1600, 0, 1600, 1000};
    Sample last{};
    PenTabletSession session(
        [&](const std::wstring& id) -> std::optional<Target> {
            return display && display->id == id ? display : std::nullopt;
        },
        [&](const Target& dest, const Sample& sample) {
            Check(dest.left == -1600, "negative target origin preserved");
            ++emitted; last = sample;
        },
        [&] { ++released; });
    auto now = PenTabletSession::Clock::now();
    Check(!session.Start(L"", surface, Mapping::PreserveAspect, now), "target required");
    Check(!session.Start(L"unknown", surface, Mapping::PreserveAspect, now), "no primary fallback");
    Check(session.Start(L"monitor-path", surface, Mapping::PreserveAspect, now), "start");
    auto generation = session.Generation();
    Sample event{generation, 1, Phase::Down, {500, 375}, .5, 0, 1};
    Check(session.Handle(event, now), "down");
    Check(last.position.x == .5 && last.position.y == .5 && last.pressure == .5, "normalized sample");
    Check(!session.Handle(event, now), "duplicate rejected");
    event.sequence = 2; event.phase = Phase::Move; event.position.y = 0;
    Check(!session.Handle(event, now) && released == 1, "exit active area releases");
    event.sequence = 3; event.position.y = 375;
    Check(!session.Handle(event, now), "reentry does not draw bridge");
    event.sequence = 4; event.phase = Phase::Down;
    Check(session.Handle(event, now), "new stroke");
    event.sequence = 5; event.phase = Phase::Cancel;
    Check(session.Handle(event, now) && released == 2, "cancel releases");
    event.sequence = 6; event.phase = Phase::Down; event.pressure = 2;
    Check(!session.Handle(event, now), "bad pressure rejected");
    event.pressure = .8;
    Check(session.Handle(event, now), "valid down");
    event.sequence = 7; event.phase = Phase::Up;
    Check(session.Handle(event, now) && last.pressure == 0, "up pressure zero");
    Check(session.Start(L"monitor-path", surface, Mapping::Stretch, now), "switch mapping");
    event.sequence = 8; event.phase = Phase::Down;
    Check(!session.Handle(event, now), "old generation rejected");
    display->width = 1920;
    session.Tick(now);
    Check(session.State() == SessionState::MappingChanged, "topology change pauses");
    Check(session.Start(L"monitor-path", surface, Mapping::Stretch, now), "restart after resize");
    display.reset(); session.Tick(now);
    Check(session.State() == SessionState::TargetGone, "unplug stops");
    display = Target{L"monitor-path", -1600, 0, 1600, 1000};
    session.Start(L"monitor-path", surface, Mapping::Stretch, now);
    Check(!session.Heartbeat(generation, now), "old heartbeat rejected");
    Check(session.Heartbeat(session.Generation(), now + std::chrono::seconds(1)), "heartbeat");
    session.Tick(now + std::chrono::seconds(2));
    Check(session.State() == SessionState::Active, "heartbeat keeps session alive");
    session.Tick(now + std::chrono::seconds(3));
    Check(session.State() == SessionState::TimedOut, "silent peer releases");
    Check(!session.Heartbeat(session.Generation(), now + std::chrono::seconds(3)), "no automatic resurrection");
    int before = released;
    session.Stop(); session.Stop();
    Check(released == before, "stop idempotent for releases");
    Check(emitted == 4, "only accepted pen events emitted");
    session.Start(L"monitor-path", surface, Mapping::Stretch, now);
    Sample touch{session.Generation(),1,Phase::Down,{500,375},0,0,1,true};
    Check(session.Handle(touch,now), "touch down accepted");
    Check(last.touch, "touch type preserved for injector");
    int releaseBeforeSwitch=released;
    Sample pen{session.Generation(),2,Phase::Down,{500,375},.5,0,1,false};
    Check(session.Handle(pen,now), "pen takes over touch");
    Check(released==releaseBeforeSwitch+1, "switch releases prior contact");
    touch.sequence=3;touch.phase=Phase::Move;
    int beforeLateTouch=released;
    Check(!session.Handle(touch,now), "touch move cannot resurrect previous drag");
    Check(released==beforeLateTouch, "rejected touch move preserves pen contact");
    touch.sequence=4;touch.phase=Phase::Cancel;
    Check(!session.Handle(touch,now), "late touch cancel rejected during pen stroke");
    Check(released==beforeLateTouch, "late cancellation preserves pen contact");
    pen.sequence=5;pen.phase=Phase::Move;
    Check(session.Handle(pen,now), "pen stroke continues after stale touch");
    session.Stop();
    Check(session.Start(L"monitor-path", surface, Mapping::PreserveAspect, now), "auxiliary session start");
    const auto auxiliaryGeneration = session.Generation();
    Check(session.AcceptAuxiliary(auxiliaryGeneration, 1, now), "auxiliary event accepted");
    Check(!session.AcceptAuxiliary(auxiliaryGeneration, 1, now), "auxiliary duplicate rejected");
    auto mappedAuxiliary = session.MapInput({500,375});
    Check(mappedAuxiliary && mappedAuxiliary->x == .5 && mappedAuxiliary->y == .5, "auxiliary shares mapping");
    Check(!session.AcceptAuxiliary(auxiliaryGeneration-1, 2, now), "old auxiliary generation rejected");
    session.Stop();

    DirectTouchState contacts;
    for(uint32_t id=10;id<15;++id) {
        auto frame=contacts.Apply(id,DirectTouchPhase::Down,Point{double(id)/100,.5});
        Check(frame && frame->size()==id-9,"touch frame includes all active contacts");
    }
    Check(contacts.Size()==5,"five contacts active");
    Check(contacts.Updates().size()==5,"stationary touch refresh keeps all contacts active");
    Check(!contacts.Apply(99,DirectTouchPhase::Down,Point{.5,.5}),"sixth contact rejected");
    auto moved=contacts.Apply(10,DirectTouchPhase::Move,Point{.25,.75});
    Check(moved && moved->front().pointerId==1 && moved->front().change==DirectTouchChange::Update,
          "touch pointer id stable across move");
    auto up=contacts.Apply(10,DirectTouchPhase::Up,std::nullopt);
    Check(up && up->size()==5 && up->front().change==DirectTouchChange::Up &&
          up->front().position.x==.25 && up->front().position.y==.75,"touch up reuses last point");
    Check(contacts.Size()==4,"touch up removes contact");
    Check(contacts.CancelAll().size()==4 && contacts.Size()==0,"cancel releases remaining contacts");
    auto reused=contacts.Apply(20,DirectTouchPhase::Down,Point{.1,.1});
    Check(reused && reused->front().pointerId==1,"touch slot reused after release");
    contacts.CancelAll();
    std::cout << checks << " checks passed\n";
}
