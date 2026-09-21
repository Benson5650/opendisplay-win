#include "RegionEditor.h"
#include "DisplayCatalog.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <thread>
#include <windowsx.h>

namespace od {
namespace {
constexpr double kMinimum = .1;
constexpr COLORREF kTransparent = RGB(1, 2, 3);
enum class Drag { None, Move, NW, NE, SW, SE };

double Clamp(double value, double low, double high)
{
    return std::min(std::max(value, low), high);
}

web::NormalizedRegion MoveRegion(web::NormalizedRegion start, double dx, double dy)
{
    start.x = Clamp(start.x + dx, 0.0, 1.0 - start.width);
    start.y = Clamp(start.y + dy, 0.0, 1.0 - start.height);
    return start;
}

web::NormalizedRegion ResizeRegion(web::NormalizedRegion start, Drag action,
                                   double dx, double dy, double aspect)
{
    const bool west = action == Drag::NW || action == Drag::SW;
    const bool north = action == Drag::NW || action == Drag::NE;
    const double anchorX = west ? start.x + start.width : start.x;
    const double anchorY = north ? start.y + start.height : start.y;
    const double maxWidth = west ? anchorX : 1.0 - anchorX;
    const double maxHeight = north ? anchorY : 1.0 - anchorY;
    const double limit = std::min(maxWidth, maxHeight * aspect);
    const double minimum = std::min(limit, std::max(kMinimum, kMinimum * aspect));
    const double freeWidth = west
        ? anchorX - Clamp(start.x + dx, 0.0, anchorX - kMinimum)
        : Clamp(start.x + start.width + dx, anchorX + kMinimum, 1.0) - anchorX;
    const double freeHeight = north
        ? anchorY - Clamp(start.y + dy, 0.0, anchorY - kMinimum)
        : Clamp(start.y + start.height + dy, anchorY + kMinimum, 1.0) - anchorY;
    const bool widthDriven = std::abs(freeWidth - start.width) >=
                             std::abs(freeHeight - start.height) * aspect;
    const double desired = widthDriven ? freeWidth : freeHeight * aspect;
    const double width = Clamp(desired, minimum, limit);
    const double height = width / aspect;
    return {west ? anchorX - width : anchorX, north ? anchorY - height : anchorY,
            width, height};
}
}

struct RegionEditor::Impl {
    std::mutex mutex;
    std::thread thread;
    std::atomic<HWND> window{};
    std::atomic<int> requestedEnd{};
    web::NormalizedRegion region{};
    web::NormalizedRegion dragStart{};
    POINT dragPoint{};
    RECT bounds{};
    double aspect = 1;
    Drag drag = Drag::None;
    uint64_t revision = 0, consumedRevision = 0;
    int finalState = 0;
    bool finalDelivered = false;

    web::NormalizedRegion ReadRegion()
    {
        std::scoped_lock lock(mutex);
        return region;
    }

    void StoreRegion(web::NormalizedRegion value, bool publish)
    {
        {
            std::scoped_lock lock(mutex);
            region = value;
            if (publish) ++revision;
        }
        if (auto hwnd = window.load()) InvalidateRect(hwnd, nullptr, FALSE);
    }

    RECT PixelRegion()
    {
        const auto value = ReadRegion();
        const int width = bounds.right - bounds.left;
        const int height = bounds.bottom - bounds.top;
        return {LONG(std::lround(value.x * width)), LONG(std::lround(value.y * height)),
                LONG(std::lround((value.x + value.width) * width)),
                LONG(std::lround((value.y + value.height) * height))};
    }

    Drag HitTest(POINT point)
    {
        const auto rect = PixelRegion();
        constexpr int radius = 24;
        const auto isNear = [&](int x, int y) {
            return std::abs(point.x - x) <= radius && std::abs(point.y - y) <= radius;
        };
        if (isNear(rect.left, rect.top)) return Drag::NW;
        if (isNear(rect.right, rect.top)) return Drag::NE;
        if (isNear(rect.left, rect.bottom)) return Drag::SW;
        if (isNear(rect.right, rect.bottom)) return Drag::SE;
        if (PtInRect(&rect, point)) return Drag::Move;
        return Drag::None;
    }

    void Finish(int state)
    {
        {
            std::scoped_lock lock(mutex);
            if (!finalState) finalState = state;
        }
        if (auto hwnd = window.load()) PostMessageW(hwnd, WM_CLOSE, 0, 0);
    }

    static LRESULT CALLBACK WndProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
    {
        auto* self = reinterpret_cast<Impl*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            self = static_cast<Impl*>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        if (!self) return DefWindowProcW(hwnd, message, wParam, lParam);
        switch (message) {
        case WM_PAINT: {
            PAINTSTRUCT ps{};
            HDC dc = BeginPaint(hwnd, &ps);
            RECT client{}; GetClientRect(hwnd, &client);
            HBRUSH shade = CreateSolidBrush(RGB(7, 12, 18));
            FillRect(dc, &client, shade); DeleteObject(shade);
            const auto rect = self->PixelRegion();
            HBRUSH clear = CreateSolidBrush(kTransparent);
            FillRect(dc, &rect, clear); DeleteObject(clear);
            HPEN pen = CreatePen(PS_SOLID, 5, RGB(136, 202, 185));
            auto oldPen = SelectObject(dc, pen);
            auto oldBrush = SelectObject(dc, GetStockObject(HOLLOW_BRUSH));
            Rectangle(dc, rect.left, rect.top, rect.right, rect.bottom);
            SelectObject(dc, oldBrush); SelectObject(dc, oldPen); DeleteObject(pen);
            HBRUSH handle = CreateSolidBrush(RGB(40, 125, 104));
            HPEN handlePen = CreatePen(PS_SOLID, 3, RGB(232, 237, 244));
            oldBrush = SelectObject(dc, handle); oldPen = SelectObject(dc, handlePen);
            for (POINT p : {POINT{rect.left,rect.top}, POINT{rect.right,rect.top},
                            POINT{rect.left,rect.bottom}, POINT{rect.right,rect.bottom}})
                Ellipse(dc, p.x-12, p.y-12, p.x+12, p.y+12);
            SelectObject(dc, oldBrush); SelectObject(dc, oldPen);
            DeleteObject(handle); DeleteObject(handlePen);
            SetBkMode(dc, TRANSPARENT); SetTextColor(dc, RGB(232, 237, 244));
            HFONT font = CreateFontW(24,0,0,0,FW_SEMIBOLD,FALSE,FALSE,FALSE,DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Segoe UI");
            auto oldFont = SelectObject(dc, font);
            RECT textRect{24,20,client.right-24,64};
            DrawTextW(dc, L"OpenDisplay 有效區  ·  拖曳矩形或四角  ·  Enter 套用  ·  Esc 取消  ·  R 最大範圍",
                -1, &textRect, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
            SelectObject(dc, oldFont); DeleteObject(font);
            EndPaint(hwnd, &ps); return 0;
        }
        case WM_LBUTTONDOWN: {
            POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
            self->drag = self->HitTest(point);
            if (self->drag != Drag::None) {
                self->dragStart = self->ReadRegion(); self->dragPoint = point; SetCapture(hwnd);
            }
            return 0;
        }
        case WM_MOUSEMOVE:
            if (self->drag != Drag::None && (wParam & MK_LBUTTON)) {
                const double dx = double(GET_X_LPARAM(lParam) - self->dragPoint.x) /
                                  (self->bounds.right - self->bounds.left);
                const double dy = double(GET_Y_LPARAM(lParam) - self->dragPoint.y) /
                                  (self->bounds.bottom - self->bounds.top);
                self->StoreRegion(self->drag == Drag::Move
                    ? MoveRegion(self->dragStart, dx, dy)
                    : ResizeRegion(self->dragStart, self->drag, dx, dy, self->aspect), true);
            }
            return 0;
        case WM_LBUTTONUP:
            self->drag = Drag::None; ReleaseCapture(); return 0;
        case WM_LBUTTONDBLCLK:
            self->Finish(2); return 0;
        case WM_RBUTTONUP:
            self->Finish(3); return 0;
        case WM_KEYDOWN:
            if (wParam == VK_RETURN) self->Finish(2);
            else if (wParam == VK_ESCAPE) self->Finish(3);
            else if (wParam == 'R') self->StoreRegion(web::FitRegionAspect({},self->aspect),true);
            return 0;
        case WM_CLOSE:
            DestroyWindow(hwnd); return 0;
        case WM_DESTROY:
            self->window = nullptr; PostQuitMessage(0); return 0;
        default: return DefWindowProcW(hwnd, message, wParam, lParam);
        }
    }

    void Run()
    {
        HDESK desktop = OpenDesktopW(L"default", 0, FALSE, DESKTOP_CREATEMENU |
            DESKTOP_CREATEWINDOW | DESKTOP_ENUMERATE | DESKTOP_HOOKCONTROL |
            DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS);
        if (!desktop) desktop = OpenInputDesktop(0, FALSE, GENERIC_ALL);
        if (desktop) SetThreadDesktop(desktop);
        HINSTANCE instance = GetModuleHandleW(nullptr);
        const wchar_t* className = L"OpenDisplayRegionEditor";
        WNDCLASSEXW wc{}; wc.cbSize=sizeof(wc); wc.style=CS_DBLCLKS;
        wc.lpfnWndProc=WndProc; wc.hInstance=instance; wc.lpszClassName=className;
        wc.hCursor=LoadCursorW(nullptr,IDC_SIZEALL); RegisterClassExW(&wc);
        HWND hwnd = CreateWindowExW(WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_LAYERED,
            className,L"OpenDisplay 有效區",WS_POPUP,bounds.left,bounds.top,
            bounds.right-bounds.left,bounds.bottom-bounds.top,nullptr,nullptr,instance,this);
        if (hwnd) {
            window=hwnd;
            SetLayeredWindowAttributes(hwnd,kTransparent,210,LWA_COLORKEY|LWA_ALPHA);
            SetWindowDisplayAffinity(hwnd,0x00000011); // WDA_EXCLUDEFROMCAPTURE where supported.
            ShowWindow(hwnd,SW_SHOW); SetForegroundWindow(hwnd); SetFocus(hwnd);
            if (const int end=requestedEnd.exchange(0)) Finish(end);
            MSG msg{};
            while (GetMessageW(&msg,nullptr,0,0)>0) {
                if (const int end=requestedEnd.exchange(0)) Finish(end);
                TranslateMessage(&msg); DispatchMessageW(&msg);
            }
        }
        {
            std::scoped_lock lock(mutex);
            if (!finalState) finalState=3;
        }
        if (desktop) CloseDesktop(desktop);
        UnregisterClassW(className,instance);
    }

    void Join()
    {
        if (thread.joinable()) {
            requestedEnd=3;
            if (auto hwnd=window.load()) PostMessageW(hwnd,WM_NULL,0,0);
            thread.join();
        }
    }
};

RegionEditor::RegionEditor() : impl_(std::make_unique<Impl>()) {}
RegionEditor::~RegionEditor() { impl_->Join(); }

bool RegionEditor::Begin(const std::wstring& displayId, web::Size surface, web::NormalizedRegion region)
{
    impl_->Join();
    if (!web::ValidRegion(region) || surface.width<=0 || surface.height<=0) return false;
    DisplayInfo selected; bool found=false;
    try { for (const auto& display : EnumerateDisplays()) if (display.id==displayId) { selected=display; found=true; break; } }
    catch (...) { return false; }
    if (!found) return false;
    impl_->bounds=selected.bounds;
    impl_->aspect=(surface.width/surface.height)/
        (double(selected.bounds.right-selected.bounds.left)/(selected.bounds.bottom-selected.bounds.top));
    {
        std::scoped_lock lock(impl_->mutex);
        impl_->region=web::FitRegionAspect(region,impl_->aspect);
        impl_->revision=impl_->consumedRevision=0;
        impl_->finalState=0; impl_->finalDelivered=false;
    }
    impl_->requestedEnd=0;
    impl_->thread=std::thread([this]{impl_->Run();});
    return true;
}

bool RegionEditor::Update(web::NormalizedRegion region)
{
    if (!web::ValidRegion(region) || !impl_->thread.joinable()) return false;
    impl_->StoreRegion(web::FitRegionAspect(region,impl_->aspect),false);
    return true;
}

void RegionEditor::End(bool commit)
{
    if (!impl_->thread.joinable()) return;
    impl_->requestedEnd=commit?2:3;
    if (auto hwnd=impl_->window.load()) PostMessageW(hwnd,WM_NULL,0,0);
}

int RegionEditor::Poll(web::NormalizedRegion& region)
{
    std::scoped_lock lock(impl_->mutex);
    region=impl_->region;
    if (impl_->consumedRevision<impl_->revision) {
        impl_->consumedRevision=impl_->revision;
        return 1;
    }
    if (impl_->finalState&&!impl_->finalDelivered) {
        impl_->finalDelivered=true;
        return impl_->finalState;
    }
    return 0;
}

} // namespace od
