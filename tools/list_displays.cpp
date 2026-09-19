#include "display/DisplayCatalog.h"
#include <iostream>

int main()
{
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    try {
        for (const auto& display : od::EnumerateDisplays()) {
            const auto& b = display.bounds;
            std::wcout << display.name << (display.primary ? L" [primary]" : L"") << L"\n"
                       << L"  id: " << display.id << L"\n  capture: " << display.deviceName
                       << L"\n  bounds: " << b.left << L"," << b.top << L" "
                       << b.right - b.left << L"x" << b.bottom - b.top << L"\n";
        }
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
