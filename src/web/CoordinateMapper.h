#pragma once

#include <algorithm>
#include <cmath>
#include <optional>

namespace od::web {
struct Point { double x, y; };
struct Size { double width, height; };
enum class Mapping { PreserveAspect, Stretch };

// Input is in CSS pixels of the drawable surface, not screen pixels or DPR.
// Output is normalized to the target. Letterbox margins are not interactive.
inline std::optional<Point> MapPoint(Point p, Size surface, Size target, Mapping mode)
{
    if (!std::isfinite(p.x) || !std::isfinite(p.y) ||
        !std::isfinite(surface.width) || !std::isfinite(surface.height) ||
        !std::isfinite(target.width) || !std::isfinite(target.height) ||
        surface.width <= 0 || surface.height <= 0 || target.width <= 0 || target.height <= 0)
        return std::nullopt;
    double width = surface.width, height = surface.height;
    if (mode == Mapping::PreserveAspect) {
        const double scale = std::min(surface.width / target.width, surface.height / target.height);
        width = target.width * scale;
        height = target.height * scale;
    }
    if (!std::isfinite(width) || !std::isfinite(height) || width <= 0 || height <= 0)
        return std::nullopt;
    const double x = (p.x - (surface.width - width) / 2) / width;
    const double y = (p.y - (surface.height - height) / 2) / height;
    if (x < 0 || x > 1 || y < 0 || y > 1)
        return std::nullopt;
    return Point{x, y};
}
} // namespace od::web
