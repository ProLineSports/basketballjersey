// Project the same corners used by the scale/rotate hit targets. SVG uses CSS
// pixels, so the outline and handles stay crisp instead of stretching a square
// texture over a wide, tilted wordmark.
export function projectSelectionFrame(frame, camera, width, height) {
  if (!frame || width <= 0 || height <= 0) return null;
  const normal = frame.corners[1].clone().sub(frame.corners[0])
    .cross(frame.corners[0].clone().sub(frame.corners[2])).normalize();
  if (normal.dot(camera.position.clone().sub(frame.center)) <= 0) return null;
  const corners = frame.corners.map(corner => {
    const view = corner.clone().applyMatrix4(camera.matrixWorldInverse);
    if (view.z >= -camera.near) return null;
    const ndc = corner.clone().project(camera);
    return { x:(ndc.x + 1) * width / 2, y:(1 - ndc.y) * height / 2 };
  });
  return corners.every(Boolean) ? corners : null;
}

export function updateSelectionOutline(svg, frames, camera, width, height) {
  if (!svg) return;
  frames.forEach((frame, index) => {
    const group = svg.children[index];
    if (!group) return;
    const corners = projectSelectionFrame(frame, camera, width, height);
    group.style.display = corners ? '' : 'none';
    if (!corners) return;
    const coordinates = [0, 1, 3, 2].map(i => `${corners[i].x.toFixed(2)},${corners[i].y.toFixed(2)}`);
    const path = `M${coordinates.join(' L')} Z`;
    group.children[0].setAttribute('d', path);
    group.children[1].setAttribute('d', path);
    corners.forEach((corner, i) => {
      const handle = group.children[i + 2];
      handle.setAttribute('x', (corner.x - 4).toFixed(2));
      handle.setAttribute('y', (corner.y - 4).toFixed(2));
    });
  });
}
