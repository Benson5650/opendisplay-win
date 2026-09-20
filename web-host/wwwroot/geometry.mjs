export function surfaceChanged(initial, current) {
  if (!initial) return false;
  // Subpixel rounding noise does not justify destroying a display session.
  return !Number.isFinite(current.width) || !Number.isFinite(current.height) ||
    Math.abs(initial.width-current.width)>0.5 || Math.abs(initial.height-current.height)>0.5;
}

export function orientDimensions(width, height, surface) {
  const landscape=surface.width>=surface.height;
  return landscape===(width>=height)?{width,height}:{width:height,height:width};
}

export function pointInsideSurface(clientX,clientY,bounds){
  const x=clientX-bounds.left,y=clientY-bounds.top;
  return Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0&&x<=bounds.width&&y<=bounds.height?{x,y}:undefined;
}
