# OpenDisplay Web — Project Handoff & Development State

> **Last Updated:** 2026-09-21
> **Repository:** `https://github.com/Benson5650/opendisplay-win.git`
> **Current Active Branch:** `master` (All features and fixes are merged and pushed to `origin/master`)
> **Preview Deployment:** `outputs/OpenDisplay-Web-Preview`

---

## 1. Executive Summary & Current Status

OpenDisplay Web transforms an iPad into a high-performance, low-latency, pressure-sensitive Windows pen tablet (and optional mirror/extended monitor) via an authenticated WebCodecs + WebSocket architecture.

All recent priority features, Apple Pencil hover/handwriting transitions, Win32 desktop station overlays, and multi-touch/trackpad foundations have been fully implemented, tested, and fast-forward merged into `master`.

### Test Suite Status (100% Passing)
- **Native C++ CTest:** `ctest --test-dir build -C Release` (100% pass)
- **Frontend Unit Tests (Node.js):**
  - `tests/display_memory_test.mjs` (8 checks pass)
  - `tests/geometry_test.mjs` (13 checks pass)
  - `tests/preferences_test.mjs` (9 checks pass)
  - `tests/finger_gestures_test.mjs` (all touch/trackpad/jitter checks pass)
  - `tests/video_packet_test.mjs` (9 checks pass)
  - `tests/video_receiver_test.mjs` (lifecycle & IDR recovery pass)
- **End-to-End Integration Tests:**
  - `tests/web_host_test.mjs` (47/47 HTTPS, WSS, TLS, auth, pairing, dry-run input tests pass)

---

## 2. Implemented Features (Delivered)

### A. Windows 螢幕識別按鈕 (Identify Displays)
- **Web UI:** 「識別螢幕」按鈕放置於螢幕下拉選單旁，點擊呼叫 `/identify` POST 端點。
- **Win32 Native Overlay (`DisplayCatalog.cpp`):**
  - 自動在每個實體螢幕中央彈出 `#101722` 深底、`#88cab9` 綠色圓角外框的識別方塊，顯示螢幕號碼與名稱。
  - **重要架構修復：** 透過 `OpenDesktopW(L"default", ...)` + `SetThreadDesktop()` 強制將視窗繪製於使用者的**實體主螢幕互動桌面**（克服 Windows 背景服務 / 終端環境預設被隔離在 `exebox-...` 虛擬桌面的問題）。
  - 實作完整 `IdentifyWndProc`（`WM_PAINT` 雙緩衝繪製）與 60Hz 訊息幫浦（`PeekMessageW`/`DispatchMessageW`），持續顯示 4 秒後平滑銷毀。

### B. Windows 游標顯示開關 (Show / Hide Cursor)
- **Web UI:** 「手寫時隱藏 Windows 系統游標」勾選框（保存在使用者本機偏好設定）。
- **Native API:** 透過 `od_set_cursor_feedback()` 調用 Win32 `CreateSyntheticPointerDevice(PT_PEN, 1, POINTER_FEEDBACK_NONE / POINTER_FEEDBACK_DEFAULT)`，書寫時徹底消除 Windows 圓圈游標。

### C. 自訂手寫映射有效區 (Custom Active Area Scale)
- **Web UI:** 提供 100%、90%、80%、70% 下拉選單。
- **人體工學與防誤觸：** 在 iPad `#surface` 上居中等比縮小 `#activeArea` 邊界框，外圍黑邊作為**手腕／手掌放置區（Palm Rest）**。
- **座標映射：** 超出有效區的外圍手寫與觸控會被原生 `MapPoint` 自動拋棄，不產生飄移筆劃。

### D. 影像解析度縮放 (Resolution Scaling)
- **Web UI:** Mirror 模式顯示「影片解析度縮放」（100% / 75% / 50%）。
- **Native Pipeline:** `DesktopDuplication` 擷取即時轉換 NV12 時執行雙線性降採樣，Media Foundation H.264 硬體編碼器動態配置為縮放解析度，顯著減輕 4K/2K 螢幕的串流延遲與 Wi-Fi 頻寬負擔。

### E. Apple Pencil Hover 與落筆過渡
- 支援 Apple Pencil 懸浮游標指示器（可於設定開啟/關閉）。
- 解決了 Hover 轉換至 Down/Move 時筆劃遺失與落筆中斷問題。

### F. 觸控手勢與防手掌誤觸
- 支援 Touchpad 相對軌跡球模式（單指滑動/點擊、雙指右鍵/捲動、防抖動與長按拖曳）。
- 支援 Windows Direct Touch 最多 5 指原生觸控。
- Pencil 靠近與落筆時自動全面抑制手指與手掌誤觸。

### G. 30 天裝置記憶與重啟免配對
- 配對成功後以 HttpOnly, Secure, SameSite=Strict Cookie 儲存授權。
- 主機端 `paired-devices.json` 僅記錄 SHA256 雜湊，重啟伺服器無須重新輸入配對碼。

---

## 3. Key Architecture & Gotchas for Codex

1. **Win32 桌面安全隔離（Desktop Isolation）：**
   - 在 Windows 上，終端機或背景工具可能執行在非預設桌面（如 `exebox-...`）。
   - 任何要在使用者實體螢幕彈出的 Win32 GUI 視窗，必須在**尚未建立任何視窗的全新執行緒**上先呼叫：
     ```cpp
     HDESK hDesk = OpenDesktopW(L"default", 0, FALSE, ...);
     if (hDesk) SetThreadDesktop(hDesk);
     ```
2. **Win32 Layered Window 渲染規則：**
   - 使用 `CreateWindowExW` 建立置頂彈出視窗時，必須掛載處理 `WM_PAINT` 的 `WndProc`，並在顯示期間執行 active message pump（`PeekMessageW`/`DispatchMessageW`），否則 DWM 不會將視窗合成到螢幕上。
3. **前端 ES Module 的 TDZ（Temporal Dead Zone）：**
   - `web-host/wwwroot/app.js` 是 `<script type="module">`，全域變數（如 `_dbg` DOM 節點）不可在宣告之前被呼叫，否則會觸發 `ReferenceError: Cannot access before initialization` 導致整個腳本初始化中斷。
4. **原生與 Managed 接口契約：**
   - `od_identify_displays()`: 觸發螢幕編號標籤。
   - `od_set_cursor_feedback(void* handle, int showCursor)`: 設定系統筆游標回饋。
   - `od_video_create(..., double scale = 1.0)`: 建立 H.264 鏡像編碼管道（支援降採樣）。

---

## 4. Build, Test, and Run Commands

### 重新編譯 Native 與 Web Host
```powershell
# 1. 編譯 C++ Native Library
cmake -S . -B build -G "Visual Studio 18 2026" -A x64
cmake --build build --config Release

# 2. 編譯 C# Web Host
dotnet build web-host/OpenDisplay.Web.csproj -c Release

# 3. 發布並複製原生 DLL 與前端資源至預覽目錄
dotnet publish web-host/OpenDisplay.Web.csproj -c Release --no-restore -o ../../outputs/OpenDisplay-Web-Preview
Copy-Item -Force build/Release/opendisplay-native.dll ../../outputs/OpenDisplay-Web-Preview/
Copy-Item -Force -Recurse web-host/wwwroot/* ../../outputs/OpenDisplay-Web-Preview/wwwroot/
```

### 執行全套測試
```powershell
# 原生測試
ctest --test-dir build -C Release

# 前端單元測試
node tests/display_memory_test.mjs
node tests/geometry_test.mjs
node tests/preferences_test.mjs
node tests/finger_gestures_test.mjs
node tests/video_packet_test.mjs
node tests/video_receiver_test.mjs

# 端對端整合測試 (TLS + Auth + WSS)
$env:NODE_EXTRA_CA_CERTS = (Resolve-Path ./host-data-test/ipad-trust.pem).Path
node tests/web_host_test.mjs
```

### 啟動 Live Input 預覽伺服器
```powershell
cd outputs/OpenDisplay-Web-Preview
.\Start-Preview.ps1 -LiveInput
```

---

## 5. Prioritized Feature Roadmap (TODO List for Codex)

### 一、短期優先推薦（Short-term Priorities）

1. **螢幕虛擬快捷工具列（On-Screen Floating Shortcut Bar）**
   - **目標：** 在全螢幕手寫板側邊（左側/右側）或頂部提供可展開/收合的繪圖快捷按鈕：
     - `Ctrl + Z`（Undo 復原）
     - `Ctrl + Y`（Redo 重做）
     - `Space`（暫時平移畫布 Pan）
     - `B` / `E`（筆刷 Brush / 橡皮擦 Eraser 切換）
   - **實作路徑：** 在 `index.html` 的 `#tablet` 內增加浮動側邊欄，透過 WebSocket 送出虛擬鍵盤擊鍵封包（呼叫 Win32 `SendInput` 鍵盤事件）。

2. **筆身快捷手勢與按鈕對應（Apple Pencil Pro Squeeze / Double-Tap）**
   - **目標：** 攔截 Apple Pencil Pro 的擠壓（Squeeze）或雙擊（Double Tap）事件，自訂觸發 Windows 動作（如切換橡皮擦、呼叫調色盤）。

3. **手寫有效區對齊配置（Active Area Alignment）**
   - **目標：** 針對 80% / 70% 有效區，除了預設「置中」，增加「靠上」、「靠下」選項，讓習慣將手腕放在 iPad 下半部邊框的使用者獲得最大化的 Palm Rest。

4. **休眠與斷線平滑自動復原（Auto-Reconnect & State Recovery）**
   - **目標：** 當 iPad 螢幕暫時休眠或切換 App 重返時，自動透過輕量握手恢復 WebSocket 連線，不需手動重新整理網頁。

---

### 二、中期功能擴充（Medium-term Enhancements）

1. **情境設定檔切換（Presets / Profiles）**
   - 一鍵切換情境配置（例如：精細繪圖檔、懸腕筆記檔、副螢幕閱讀檔）。
2. **可視化貝茲壓力曲線編輯器（Bezier Pressure Curve Editor）**
   - 在 Web 端提供雙控制點的曲線拖曳介面，自訂落筆加粗力道。
3. **低延遲系統音訊轉發（Audio Forwarding via Web Audio）**
   - 在 Mirror / Extend 模式下將 Windows 桌面音效同步串流至 iPad 播放。

---

### 三、長期效能與底層架構（Long-term Goals）

1. **WebRTC DataChannel 傳輸升級**
   - 將影像與輸入轉移至 WebRTC UDP 傳輸，進一步消除 Wi-Fi 抖動下的封包重傳延遲。
2. **AV1 / HEVC (H.265) 硬體編碼**
   - 提升高解析度繪圖與文字顯示的邊緣銳利度並節省頻寬。
3. **USB 有線直連模式（USBMuxd）**
   - 支援 Type-C 有線連接，達成低於 5ms 的極限輸入延遲與 0 無線干擾。
