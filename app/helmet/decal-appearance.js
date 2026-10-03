function matchingCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width; canvas.height = source.height;
  return canvas;
}

// Border opacity controls its visible tint, not the physical film silhouette.
// Keep that silhouette independent so a clear border still catches light and
// casts its contact shadow from its outer edge.
export function strokeDecalCanvas(source, { enabled = false, thickness = 0, color = '#ffffff', opacity = 1 } = {}) {
  if (!enabled || thickness <= 0) return { artwork:source, footprint:null };
  const footprint = matchingCanvas(source), mask = footprint.getContext('2d');
  const steps = Math.max(12, Math.ceil(thickness * 12));
  for (let i = 0; i < steps; i++) {
    const angle = i / steps * Math.PI * 2;
    mask.drawImage(source, Math.cos(angle) * thickness, Math.sin(angle) * thickness);
  }
  mask.drawImage(source, 0, 0);
  mask.globalCompositeOperation = 'source-in';
  mask.fillStyle = '#ffffff'; mask.fillRect(0, 0, footprint.width, footprint.height);

  const artwork = matchingCanvas(source), art = artwork.getContext('2d');
  if (opacity > 0) {
    const border = matchingCanvas(source), tint = border.getContext('2d');
    tint.drawImage(footprint, 0, 0);
    tint.globalCompositeOperation = 'destination-out'; tint.drawImage(source, 0, 0);
    tint.globalCompositeOperation = 'source-in';
    tint.fillStyle = color; tint.fillRect(0, 0, border.width, border.height);
    // Apply tint opacity once during the final draw, separate from masking.
    art.globalAlpha = opacity; art.drawImage(border, 0, 0); art.globalAlpha = 1;
  }
  art.drawImage(source, 0, 0);
  return { artwork, footprint };
}

// Artwork-space edge shading follows the film outline, including holes in letters.
// Its footprint is based on visible artwork height, so wide wordmarks and small
// rear decals retain the same restrained vinyl edge instead of a broad glow.
export function raisedDecalCanvases(source, artworkHeight, { shadowProfile = 'decal', footprint = null } = {}) {
  const canvas = () => matchingCanvas(source);
  const boundary = footprint || source;
  const edge = Math.max(1, artworkHeight * 0.009);
  const innerEdge = (dx, dy, color, opacity) => {
    const result = canvas(), ctx = result.getContext('2d');
    ctx.drawImage(boundary, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(boundary, dx, dy);
    ctx.globalCompositeOperation = 'source-in';
    ctx.globalAlpha = opacity; ctx.fillStyle = color;
    ctx.fillRect(0, 0, result.width, result.height);
    return result;
  };
  const artwork = canvas(), artCtx = artwork.getContext('2d');
  artCtx.drawImage(source, 0, 0);
  artCtx.drawImage(innerEdge(edge, -edge, '#000000', 0.24), 0, 0);
  artCtx.drawImage(innerEdge(-edge, edge, '#ffffff', 0.32), 0, 0);
  // Inner-edge compositing adds opacity at antialiased boundaries; restore the
  // film silhouette. A transparent stroke still retains its thin edge reflection.
  artCtx.globalCompositeOperation = 'destination-in'; artCtx.drawImage(boundary, 0, 0);
  const shadow = canvas(), shadowCtx = shadow.getContext('2d');
  const bumper = shadowProfile === 'bumper';
  const distance = edge * (bumper ? 1.4 : 0.45);
  shadowCtx.filter = `blur(${Math.max(0.35, edge * (bumper ? 0.65 : 0.18))}px)`;
  shadowCtx.drawImage(boundary, -distance, distance);
  shadowCtx.filter = 'none'; shadowCtx.globalCompositeOperation = 'source-in';
  shadowCtx.globalAlpha = 0.7; shadowCtx.fillStyle = '#000000';
  shadowCtx.fillRect(0, 0, shadow.width, shadow.height);
  shadowCtx.globalAlpha = 1; shadowCtx.globalCompositeOperation = 'destination-out';
  shadowCtx.drawImage(boundary, 0, 0);
  return { artwork, shadow };
}
