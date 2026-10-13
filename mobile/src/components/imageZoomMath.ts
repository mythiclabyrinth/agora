export type ImageZoom = { scale: number; x: number; y: number };

export function zoomAtPoint(
  current: ImageZoom,
  scale: number,
  startFocalX: number,
  startFocalY: number,
  focalX: number,
  focalY: number,
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  minScale = 1,
): ImageZoom {
  "worklet";
  const boundedScale = Math.max(minScale, Math.min(5, scale));
  const ratio = boundedScale / current.scale;
  const maxX = Math.max(0, (imageWidth * boundedScale - viewportWidth) / 2);
  const maxY = Math.max(0, (imageHeight * boundedScale - viewportHeight) / 2);
  return {
    scale: boundedScale,
    x: Math.max(-maxX, Math.min(maxX, focalX - (startFocalX - current.x) * ratio)),
    y: Math.max(-maxY, Math.min(maxY, focalY - (startFocalY - current.y) * ratio)),
  };
}

export function fitImageToViewport(naturalWidth: number, naturalHeight: number, viewportWidth: number, viewportHeight: number) {
  if (naturalWidth <= 0 || naturalHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return { width: 0, height: 0 };
  }
  const ratio = Math.min(viewportWidth / naturalWidth, viewportHeight / naturalHeight);
  return { width: naturalWidth * ratio, height: naturalHeight * ratio };
}

export function clampZoom(
  value: ImageZoom,
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): ImageZoom {
  "worklet";
  const scale = Math.max(1, Math.min(5, value.scale));
  const maxX = Math.max(0, (imageWidth * scale - viewportWidth) / 2);
  const maxY = Math.max(0, (imageHeight * scale - viewportHeight) / 2);
  return {
    scale,
    x: Math.max(-maxX, Math.min(maxX, value.x)),
    y: Math.max(-maxY, Math.min(maxY, value.y)),
  };
}
