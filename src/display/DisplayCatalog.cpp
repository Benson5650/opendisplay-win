#include "DisplayCatalog.h"
#include <atomic>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

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

struct OverlayInfo {
    int number{};
    std::wstring name;
};

static LRESULT CALLBACK IdentifyWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);
        auto* info = reinterpret_cast<OverlayInfo*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        RECT rc;
        GetClientRect(hwnd, &rc);
        int winW = rc.right - rc.left;
        int winH = rc.bottom - rc.top;

        HBRUSH bg = CreateSolidBrush(RGB(16, 23, 34));
        FillRect(hdc, &rc, bg);
        DeleteObject(bg);

        HPEN borderPen = CreatePen(PS_SOLID, 4, RGB(136, 202, 185));
        HGDIOBJ oldPen = SelectObject(hdc, borderPen);
        HGDIOBJ oldBrush = SelectObject(hdc, GetStockObject(HOLLOW_BRUSH));
        RoundRect(hdc, 2, 2, winW - 2, winH - 2, 24, 24);
        SelectObject(hdc, oldBrush);
        SelectObject(hdc, oldPen);
        DeleteObject(borderPen);

        SetBkMode(hdc, TRANSPARENT);

        HFONT bigFont = CreateFontW(100, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
        HGDIOBJ oldFont = SelectObject(hdc, bigFont);
        SetTextColor(hdc, RGB(136, 202, 185));
        std::wstring numStr = info ? std::to_wstring(info->number) : L"1";
        RECT numRc{0, 15, winW, 125};
        DrawTextW(hdc, numStr.c_str(), -1, &numRc, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

        HFONT nameFont = CreateFontW(22, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
        SelectObject(hdc, nameFont);
        SetTextColor(hdc, RGB(232, 237, 244));
        RECT nameRc{12, 135, winW - 12, 210};
        std::wstring title = info ? info->name : L"";
        DrawTextW(hdc, title.c_str(), -1, &nameRc, DT_CENTER | DT_WORDBREAK);

        SelectObject(hdc, oldFont);
        DeleteObject(bigFont);
        DeleteObject(nameFont);

        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_ERASEBKGND:
        return 1;
    default:
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
}

static std::atomic<bool> g_identifying{false};

void IdentifyDisplays()
{
    bool expected = false;
    if (!g_identifying.compare_exchange_strong(expected, true)) return;

    std::thread([] {
        struct ScopeExit {
            ~ScopeExit() { g_identifying = false; }
        } exitGuard;

        std::vector<DisplayInfo> displays;
        try {
            displays = EnumerateDisplays();
        } catch (...) { return; }
        if (displays.empty()) return;

        HINSTANCE hInstance = GetModuleHandleW(nullptr);
        const wchar_t* className = L"OpenDisplayIdentifyOverlay";

        WNDCLASSEXW wc{};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = IdentifyWndProc;
        wc.hInstance = hInstance;
        wc.lpszClassName = className;
        wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
        RegisterClassExW(&wc);

        std::vector<OverlayInfo> infoList(displays.size());
        std::vector<HWND> hwnds;

        for (size_t i = 0; i < displays.size(); ++i) {
            const auto& d = displays[i];
            int monW = d.bounds.right - d.bounds.left;
            int monH = d.bounds.bottom - d.bounds.top;
            int winW = 320, winH = 220;
            int winX = d.bounds.left + (monW - winW) / 2;
            int winY = d.bounds.top + (monH - winH) / 2;

            infoList[i].number = static_cast<int>(i + 1);
            infoList[i].name = d.name;
            if (d.primary) infoList[i].name += L" (主要)";

            HWND hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
                className, L"OpenDisplay Identify",
                WS_POPUP, winX, winY, winW, winH,
                nullptr, nullptr, hInstance, nullptr);

            if (hwnd) {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&infoList[i]));
                SetLayeredWindowAttributes(hwnd, 0, 245, LWA_ALPHA);
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE);
                InvalidateRect(hwnd, nullptr, TRUE);
                UpdateWindow(hwnd);
                hwnds.push_back(hwnd);
            }
        }

        auto start = std::chrono::steady_clock::now();
        while (std::chrono::steady_clock::now() - start < std::chrono::milliseconds(4000)) {
            MSG msg;
            while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(15));
        }

        for (HWND h : hwnds) {
            DestroyWindow(h);
        }
        UnregisterClassW(className, hInstance);
    }).detach();
}
}
