#pragma once

#include <algorithm>
#include <cstdint>

namespace od {

// SendInput maps the 0..65535 absolute range over 65536 sub-pixel units.
// Aim at the center of a physical pixel; mapping its left edge repeatedly can
// round back one pixel and makes vertical trackpad motion drift left.
inline long NormalizeAbsoluteCoordinate(long screenCoord, long origin, long extent)
{
    if (extent <= 0) return 0;
    const int64_t relative = std::clamp<int64_t>(
        static_cast<int64_t>(screenCoord) - origin, 0, extent - 1);
    const int64_t centered = ((relative * 2 + 1) * 65536) / (static_cast<int64_t>(extent) * 2);
    return static_cast<long>(std::clamp<int64_t>(centered, 0, 65535));
}

} // namespace od
