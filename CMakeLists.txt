cmake_minimum_required(VERSION 3.20)
project(opendisplay-win CXX)

include(CTest)

if(NOT WIN32)
  message(FATAL_ERROR "opendisplay-win only builds on Windows (Media Foundation, DXGI, Win32).")
endif()

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Static CRT so a released .exe runs on a bare Windows box without the VC++
# Redistributable installed. Costs ~250 KB; the UCRT part (api-ms-win-crt-*)
# ships with Windows 10/11 either way.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(opendisplay-list-displays tools/list_displays.cpp src/display/DisplayCatalog.cpp)
target_include_directories(opendisplay-list-displays PRIVATE src)
target_compile_definitions(opendisplay-list-displays PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(opendisplay-list-displays PRIVATE user32)

add_library(opendisplay-native SHARED src/web/NativeBridge.cpp src/web/VideoPipeline.cpp
  src/display/DesktopDuplication.cpp src/encode/H264Encoder.cpp src/encode/AnnexB.cpp
  src/display/DisplayCatalog.cpp src/display/RegionEditor.cpp src/display/VirtualDisplay.cpp
  src/app/Log.cpp src/input/InputInjector.cpp)
target_include_directories(opendisplay-native PRIVATE src third_party/parsec-vdd)
target_compile_definitions(opendisplay-native PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(opendisplay-native PRIVATE user32 d3d11 dxgi dxguid mfplat mf mfreadwrite mfuuid setupapi cfgmgr32 shell32)

if(BUILD_TESTING)
  add_executable(web-core-tests tests/web_core_tests.cpp)
  target_include_directories(web-core-tests PRIVATE src)
  add_test(NAME web-core COMMAND web-core-tests)
endif()

add_executable(opendisplay-win
  src/main.cpp
  src/net/Connection.cpp
  src/net/Protocol.cpp
  src/net/Mdns.cpp
  src/encode/AnnexB.cpp
  src/encode/H264Encoder.cpp
  src/display/VirtualDisplay.cpp
  src/display/DesktopDuplication.cpp
  src/input/InputInjector.cpp
  src/app/Log.cpp
  src/app/SenderApp.cpp
  src/app/Config.cpp
  src/app/TrayApp.cpp
  src/app/resources.rc
)

target_include_directories(opendisplay-win PRIVATE
  src
  third_party/parsec-vdd
)

target_link_libraries(opendisplay-win PRIVATE
  ws2_32
  user32
  d3d11
  dxgi
  dxguid
  mfplat
  mf
  mfreadwrite
  mfuuid
  setupapi
  cfgmgr32
  shell32
  gdi32
)

target_compile_definitions(opendisplay-win PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)

# asInvoker (not requireAdministrator): the app runs un-elevated. The only
# operation that needs admin is registering a new iPad resolution as a
# parsec-vdd custom mode (one HKLM write); that path self-elevates a one-off
# (`--register-resolution`). Running the whole app elevated is optional (tray
# menu) — only needed to inject touch into elevated windows.
#
# GUI subsystem so the tray app doesn't flash a console window, but keep
# mainCRTStartup as the entry point so we still have a normal main(argc, argv)
# (populated from the command line) for the headless CLI mode.
target_link_options(opendisplay-win PRIVATE
  "/MANIFESTUAC:level='asInvoker' uiAccess='false'"
  "/SUBSYSTEM:WINDOWS"
  "/ENTRY:mainCRTStartup"
)
