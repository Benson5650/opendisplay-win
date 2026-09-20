internal static class PressureCurve
{
    public static double Apply(double pressure, string curve)
    {
        if (!double.IsFinite(pressure) || pressure < 0 || pressure > 1)
            throw new System.Text.Json.JsonException("Invalid pressure");
        return curve switch {
            "soft" => Math.Sqrt(pressure),
            "linear" => pressure,
            "firm" => pressure * pressure,
            _ => throw new System.Text.Json.JsonException("Invalid pressure curve")
        };
    }
}
