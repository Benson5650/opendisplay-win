using System.Runtime.InteropServices;
using System.Text;

internal static class Native
{
    private const string Lib = "opendisplay-native";
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern nint od_create(int dryRun);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void od_destroy(nint h);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode)] public static extern int od_displays(StringBuilder b, int capacity);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode)] public static extern ulong od_start(nint h, string id, double w, double height, int stretch);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int od_tick(nint h);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void od_stop(nint h);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int od_heartbeat(nint h, ulong generation);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int od_sample(nint h, ulong g, ulong seq, int phase, double x, double y, double p, double az, double alt);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern ulong od_emitted(nint h);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(nint context);
}
