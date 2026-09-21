#pragma once

#include "web/CoordinateMapper.h"
#include <memory>
#include <string>

namespace od {

// Interactive, capture-excluded overlay on one physical Windows display.
// Poll returns 1 for a live Windows-side change, 2 for commit, 3 for cancel.
class RegionEditor {
public:
    RegionEditor();
    ~RegionEditor();
    RegionEditor(const RegionEditor&) = delete;
    RegionEditor& operator=(const RegionEditor&) = delete;

    bool Begin(const std::wstring& displayId, web::Size surface, web::NormalizedRegion region);
    bool Update(web::NormalizedRegion region);
    void End(bool commit);
    int Poll(web::NormalizedRegion& region);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace od
