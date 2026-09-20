using System.Text.Json;

int checks = 0;
void Check(bool condition, string label) {
    checks++;
    if (!condition) throw new Exception(label);
}
void Reject(double value, string curve) {
    try { PressureCurve.Apply(value, curve); }
    catch (JsonException) { checks++; return; }
    throw new Exception("Invalid input accepted");
}
foreach (var curve in new[] { "soft", "linear", "firm" }) {
    Check(PressureCurve.Apply(0, curve) == 0, "zero endpoint");
    Check(PressureCurve.Apply(1, curve) == 1, "one endpoint");
    double previous = -1;
    for (int i = 0; i <= 1000; i++) {
        var result = PressureCurve.Apply(i / 1000.0, curve);
        Check(result >= previous && result >= 0 && result <= 1, "bounded monotonic curve");
        previous = result;
    }
    foreach (var invalid in new[] { -0.1, 1.1, double.NaN, double.PositiveInfinity, double.NegativeInfinity }) Reject(invalid, curve);
}
Check(PressureCurve.Apply(.25, "soft") == .5, "soft sample");
Check(PressureCurve.Apply(.25, "linear") == .25, "linear sample");
Check(PressureCurve.Apply(.5, "firm") == .25, "firm sample");
Reject(.5, "unknown");
Console.WriteLine($"{checks} pressure curve checks passed");
