#include "DisplayCatalog.h"
#include <stdexcept>

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
}
