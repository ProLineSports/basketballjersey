export function getSquareExportPlan(renderer, resolution, requestedSupersample) {
  const gl = renderer.getContext();
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  const viewportLimits = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  const safeDimension = Math.max(1, Math.min(
    Number(maxTextureSize) || 4096,
    Number(maxRenderbufferSize) || 4096,
    Number(viewportLimits?.[0]) || 4096,
    Number(viewportLimits?.[1]) || 4096,
    8192
  ));
  const finalSize = Math.max(1, Math.round(resolution));
  const supported = finalSize <= safeDimension;
  const actualSupersample = supported
    ? Math.max(1, Math.min(requestedSupersample, Math.floor(safeDimension / finalSize)))
    : 0;

  return {
    supported,
    finalWidth: finalSize,
    finalHeight: finalSize,
    maxTextureSize,
    maxRenderbufferSize,
    safeDimension,
    requestedSupersample,
    actualSupersample,
    renderWidth: finalSize * actualSupersample,
    renderHeight: finalSize * actualSupersample,
  };
}

export function resizeSquareExportRenderer(renderer, plan) {
  const gl = renderer.getContext();
  renderer.setPixelRatio(1);

  // Reported GPU limits do not guarantee the full buffer can be allocated.
  // A viewport larger than the actual buffer clips the frame. Reduce only the
  // supersampling until the entire square fits; retain the final PNG size.
  for (let supersample = plan.actualSupersample; supersample >= 1; supersample--) {
    const edge = plan.finalWidth * supersample;
    renderer.setSize(edge, edge, false);
    if (gl.isContextLost()) throw new Error('Graphics context lost. Refresh and try exporting again.');
    if (gl.drawingBufferWidth !== edge || gl.drawingBufferHeight !== edge) continue;
    renderer.setViewport(0, 0, edge, edge);
    return {
      ...plan,
      actualSupersample: supersample,
      renderWidth: edge,
      renderHeight: edge,
    };
  }

  throw new Error(`This device cannot allocate the full ${plan.finalWidth}×${plan.finalHeight} export. Try a smaller final size.`);
}
