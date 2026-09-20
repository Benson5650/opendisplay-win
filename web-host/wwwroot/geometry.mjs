export function surfaceChanged(initial, current) {
  if (!initial) return false;
  // Subpixel rounding noise does not justify destroying a display session.
  return !Number.isFinite(current.width) || !Number.isFinite(current.height) ||
    Math.abs(initial.width-current.width)>0.5 || Math.abs(initial.height-current.height)>0.5;
}
