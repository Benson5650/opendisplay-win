#include "DisplayCatalog.h"
#include <chrono>
#include <stdexcept>
#include <thread>

namespace od {
std::vector<DisplayInfo> EnumerateDisplays()
{
    std::vector<DISPLAYCONFIG_PATH_INFO> paths;
    std::vector<DISPLAYCONFIG_MODE_INFO> modes;
    LONG result = ERROR_INSUFFICIENT_BUFFER;
    for (int attempt = 0; attempt < 5 && result == ERROR_INSUFFICIENT_BUFFER; ++attempt) {
        UINT32 pathCount = 0, modeCount = 0;
        result = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount);
        if (result != ERROR_SUCCESS) break;
        paths.resize(pathCount);
        modes.resize(modeCount);
        result = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &pathCount, paths.data(),
                                    &modeCount, modes.data(), nullptr);
        paths.resize(pathCount);
    }
    if (result != ERROR_SUCCESS) throw std::runtime_error("Display topology unavailable");
    std::vector<DisplayInfo> displays;
    for (const auto& path : paths) {
        DISPLAYCONFIG_TARGET_DEVICE_NAME target{};
        target.header = {DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME, sizeof(target),
                         path.targetInfo.adapterId, path.targetInfo.id};
        DISPLAYCONFIG_SOURCE_DEVICE_NAME source{};
        source.header = {DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, sizeof(source),
                         path.sourceInfo.adapterId, path.sourceInfo.id};
        if (DisplayConfigGetDeviceInfo(&target.header) != ERROR_SUCCESS ||
            DisplayConfigGetDeviceInfo(&source.header) != ERROR_SUCCESS ||
            target.monitorDevicePath[0] == L'\0') continue;
        DEVMODEW mode{};
        mode.dmSize = sizeof(mode);
        if (!EnumDisplaySettingsW(source.viewGdiDeviceName, ENUM_CURRENT_SETTINGS, &mode)) continue;
        if (!mode.dmPelsWidth || !mode.dmPelsHeight) continue;
        DisplayInfo info;
        info.id = target.monitorDevicePath;
        info.name = target.monitorFriendlyDeviceName;
        info.deviceName = source.viewGdiDeviceName;
        if (info.name.empty()) info.name = info.deviceName;
        info.bounds = {mode.dmPosition.x, mode.dmPosition.y,
                       mode.dmPosition.x + LONG(mode.dmPelsWidth), mode.dmPosition.y + LONG(mode.dmPelsHeight)};
        info.primary = mode.dmPosition.x == 0 && mode.dmPosition.y == 0;
        displays.push_back(std::move(info));
    }
    return displays;
}

void IdentifyDisplays()
{
    std::thread([] {
        std::vector<DisplayInfo> displays;
        try {
            displays = EnumerateDisplays();
        } catch (...) { return; }
        if (displays.empty()) return;

        HINSTANCE hInstance = GetModuleHandleW(nullptr);
        const wchar_t* className = L"OpenDisplayIdentifyOverlay";

        WNDCLASSEXW wc{};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = DefWindowProcW;
        wc.hInstance = hInstance;
        wc.lpszClassName = className;
        wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
        RegisterClassExW(&wc);

        std::vector<HWND> hwnds;
        for (size_t i = 0; i < displays.size(); ++i) {
            const auto& d = displays[i];
            int monW = d.bounds.right - d.bounds.left;
            int monH = d.bounds.bottom - d.bounds.top;
            int winW = 320, winH = 220;
            int winX = d.bounds.left + (monW - winW) / 2;
            int winY = d.bounds.top + (monH - winH) / 2;

            HWND hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
                className, L"OpenDisplay Identify",
                WS_POPUP, winX, winY, winW, winH,
                nullptr, nullptr, hInstance, nullptr);

            if (hwnd) {
                SetLayeredWindowAttributes(hwnd, 0, 235, LWA_ALPHA);
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                UpdateWindow(hwnd);

                HDC hdc = GetDC(hwnd);
                if (hdc) {
                    RECT rc{0, 0, winW, winH};
                    HBRUSH bg = CreateSolidBrush(RGB(16, 23, 34));
                    FillRect(hdc, &rc, bg);
                    DeleteObject(bg);

                    HPEN borderPen = CreatePen(PS_SOLID, 3, RGB(136, 202, 185));
                    HGDIOBJ oldPen = SelectObject(hdc, borderPen);
                    HGDIOBJ oldBrush = SelectObject(hdc, GetStockObject(HOLLOW_BRUSH));
                    RoundRect(hdc, 2, 2, winW - 2, winH - 2, 20, 20);
                    SelectObject(hdc, oldBrush);
                    SelectObject(hdc, oldPen);
                    DeleteObject(borderPen);

                    SetBkMode(hdc, TRANSPARENT);

                    HFONT bigFont = CreateFontW(100, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                        CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
                    HGDIOBJ oldFont = SelectObject(hdc, bigFont);
                    SetTextColor(hdc, RGB(136, 202, 185));
                    std::wstring numStr = std::to_wstring(i + 1);
                    RECT numRc{0, 15, winW, 125};
                    DrawTextW(hdc, numStr.c_str(), -1, &numRc, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

                    HFONT nameFont = CreateFontW(20, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                        CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
                    SelectObject(hdc, nameFont);
                    SetTextColor(hdc, RGB(232, 237, 244));
                    RECT nameRc{10, 135, winW - 10, 205};
                    std::wstring title = d.name;
                    if (d.primary) title += L" (主要)";
                    DrawTextW(hdc, title.c_str(), -1, &nameRc, DT_CENTER | DT_WORDBREAK);

                    SelectObject(hdc, oldFont);
                    DeleteObject(bigFont);
                    DeleteObject(nameFont);
                    ReleaseDC(hwnd, hdc);
                }
                hwnds.push_back(hwnd);
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(2500));
        for (HWND h : hwnds) {
            DestroyWindow(h);
        }
        UnregisterClassW(className, hInstance);
    }).detach();
}
}
