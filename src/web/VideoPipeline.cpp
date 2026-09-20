#include "VideoPipeline.h"
#include "display/DesktopDuplication.h"
#include <chrono>

namespace od::web {
void VideoPipeline::Stop()
{
    stop_ = true;
    if (worker_.joinable()) worker_.join();
    std::lock_guard lock(mutex_);
    pending_.reset(); state_ = 0; width_ = 0; height_ = 0;
}
void VideoPipeline::Start(std::wstring device, unsigned fps, unsigned bitrate, double scale)
{
    Stop();
    if (device.empty() || (fps != 30 && fps != 60) || bitrate < 4'000'000 || bitrate > 24'000'000) { state_ = -1; return; }
    if (scale <= 0.2 || scale > 1.0) scale = 1.0;
    stop_ = false; keyRequested_ = true; state_ = 1;
    worker_ = std::thread([this, device = std::move(device), fps, bitrate, scale] {
        try {
            H264Encoder encoder; // Destroy after DXGI, before leaving COM thread.
            DesktopDuplication capture;
            if (!capture.Open(device)) { state_ = -1; return; }
            unsigned encW = static_cast<unsigned>(std::round(capture.Width() * scale));
            unsigned encH = static_cast<unsigned>(std::round(capture.Height() * scale));
            encW = (encW / 2) * 2; encH = (encH / 2) * 2;
            if (encW < 320 || encH < 240) { encW = capture.Width(); encH = capture.Height(); }
            if (encW % 2 || encH % 2 || !encoder.Configure(encW, encH, fps, bitrate)) {
                state_ = -1; return;
            }
            width_ = encW; height_ = encH; state_ = 2;
            std::vector<uint8_t> pixels;
            bool haveFrame = false, awaitingKey = true;
            auto lastFrame = std::chrono::steady_clock::now();
            while (!stop_) {
                const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1000 / fps);
                bool changed = capture.CaptureFrameNv12(pixels, 1000 / fps, encW, encH);
                if (capture.Width() == 0 || capture.Height() == 0) { state_ = -1; return; }
                if (changed) { haveFrame = true; lastFrame = std::chrono::steady_clock::now(); }
                if (!haveFrame) {
                    if (std::chrono::steady_clock::now() - lastFrame > std::chrono::seconds(5)) { state_ = -1; return; }
                    std::this_thread::sleep_until(deadline); continue;
                }
                if (keyRequested_.exchange(false)) {
                    encoder.RequestKeyFrame(); awaitingKey = true;
                    std::lock_guard lock(mutex_); pending_.reset();
                }
                auto frames = encoder.EncodeNv12(pixels.data(), pixels.size());
                for (auto& frame : frames) {
                    if (awaitingKey && !frame.isKeyFrame) continue;
                    std::lock_guard lock(mutex_);
                    if (pending_) {
                        // Never retain a delta after dropping its reference frame.
                        pending_.reset(); awaitingKey = true; keyRequested_ = true;
                        continue;
                    }
                    if (frame.isKeyFrame) awaitingKey = false;
                    pending_ = std::move(frame);
                }
                std::this_thread::sleep_until(deadline);
            }
        } catch (...) { state_ = -1; }
    });
}
std::optional<EncodedFrame> VideoPipeline::Take()
{
    std::lock_guard lock(mutex_);
    auto frame = std::move(pending_); pending_.reset(); return frame;
}
}
