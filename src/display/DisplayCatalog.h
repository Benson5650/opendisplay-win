#pragma once
#include <windows.h>
#include <string>
#include <vector>

namespace od {
struct DisplayInfo {
    std::wstring id; // Monitor device path, not a persisted DISPLAYn ordinal.
    std::wstring name;
    std::wstring deviceName; // Current GDI capture name only.
    RECT bounds{};
    bool primary{};
};
// Throws on enumeration failure; never substitutes the primary monitor.
std::vector<DisplayInfo> EnumerateDisplays();
void IdentifyDisplays();
}
