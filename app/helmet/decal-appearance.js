// Artwork-space edge shading follows every outline, including holes in letters.
// Its footprint is based on visible artwork height, so wide wordmarks and small
// rear decals retain the same restrained vinyl edge instead of a broad glow.
export function raisedDecalCanvases(source, artworkHeight, { shadowProfile = 'decal' } = {}) {
  const canvas = () => {
    const result = document.createElement('canvas');
    result.width = source.width; result.height = source.height;
    return result;
  };
  const edge = Math.max(1, artworkHeight * 0.009);
  const innerEdge = (dx, dy, color, opacity) => {
    const result = canvas(), ctx = result.getContext('2d');
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(source, dx, dy);
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
  // original silhouette so shading cannot enlarge or thicken the user's artwork.
  artCtx.globalCompositeOperation = 'destination-in'; artCtx.drawImage(source, 0, 0);
  const shadow = canvas(), shadowCtx = shadow.getContext('2d');
  const bumper = shadowProfile === 'bumper';
  const distance = edge * (bumper ? 1.4 : 0.45);
  shadowCtx.filter = `blur(${Math.max(0.35, edge * (bumper ? 0.65 : 0.18))}px)`;
  shadowCtx.drawImage(source, -distance, distance);
  shadowCtx.filter = 'none'; shadowCtx.globalCompositeOperation = 'source-in';
  shadowCtx.globalAlpha = 0.7; shadowCtx.fillStyle = '#000000';
  shadowCtx.fillRect(0, 0, shadow.width, shadow.height);
  shadowCtx.globalAlpha = 1; shadowCtx.globalCompositeOperation = 'destination-out';
  shadowCtx.drawImage(source, 0, 0);
  return { artwork, shadow };
}
