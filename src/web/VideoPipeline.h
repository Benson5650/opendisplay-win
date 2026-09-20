#pragma once
#include "encode/H264Encoder.h"
#include <atomic>
#include <mutex>
#include <thread>
#include <optional>
#include <string>

namespace od::web {
// All COM/MF/capture objects are created and destroyed on the worker thread.
// The consumer must request an IDR after dropping any access unit downstream.
class VideoPipeline {
public:
    ~VideoPipeline() { Stop(); }
    void Start(std::wstring device, unsigned fps, unsigned bitrate, double scale = 1.0);
    void Stop();
    void RequestKeyFrame() { keyRequested_ = true; }
    std::optional<EncodedFrame> Take();
    int State() const { return state_; } // 0 stopped, 1 starting, 2 running, -1 failed
    unsigned Width() const { return width_; }
    unsigned Height() const { return height_; }
private:
    std::thread worker_;
    std::atomic<bool> stop_{false}, keyRequested_{false};
    std::atomic<int> state_{0};
    std::atomic<unsigned> width_{0}, height_{0};
    std::mutex mutex_;
    std::optional<EncodedFrame> pending_;
};
}
