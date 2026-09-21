#pragma once

#include <algorithm>
#include <cmath>
#include <optional>

namespace od::web {
struct Point { double x, y; };
struct Size { double width, height; };
struct NormalizedRegion { double x = 0, y = 0, width = 1, height = 1; };
enum class Mapping { PreserveAspect, Stretch };

inline bool ValidRegion(NormalizedRegion region)
{
    return std::isfinite(region.x) && std::isfinite(region.y) &&
        std::isfinite(region.width) && std::isfinite(region.height) &&
        region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 &&
        region.x + region.width <= 1.0 && region.y + region.height <= 1.0;
}

// A normalized rectangle's physical aspect is
// (width * target width) / (height * target height).  Therefore the desired
// normalized aspect is surface aspect / target aspect.  Keep the requested
// rectangle as a bounding box and center the largest matching rectangle in it.
inline NormalizedRegion FitRegionAspect(NormalizedRegion region, double normalizedAspect)
{
    if (!ValidRegion(region) || !std::isfinite(normalizedAspect) || normalizedAspect <= 0)
        return region;
    double width = region.width;
    double height = region.height;
    if (width / height > normalizedAspect) width = height * normalizedAspect;
    else height = width / normalizedAspect;
    return {region.x + (region.width - width) / 2,
            region.y + (region.height - height) / 2, width, height};
}

inline std::optional<Point> ApplyRegion(std::optional<Point> point, NormalizedRegion region)
{
    if (!point || !ValidRegion(region)) return std::nullopt;
    return Point{region.x + point->x * region.width, region.y + point->y * region.height};
}

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
