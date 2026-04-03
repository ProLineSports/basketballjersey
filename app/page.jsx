'use client';
import React, { useState, useRef, useEffect, useCallback } from "react";
import { useUser, useClerk, UserButton } from "@clerk/nextjs";

const CREDITS_INITIAL = 3;

const COLLAR_OPTIONS = [
  { id: "u-neck",          label: "U-Neck",      file: "U-Neck-Base.png",          svgFile: "u-neck.svg",          trimFile: "trim-u-neck.svg" },
  { id: "v-neck-standard", label: "V-Neck",       file: "V-Neck-Standard-Base.png", svgFile: "v-neck-standard.svg", trimFile: "trim-v-neck.svg" },
  { id: "v-neck-overlap",  label: "V-Overlap",    file: "V-Neck-Overlap-Base.png",  svgFile: "v-neck-overlap.svg",  trimFile: "trim-v-neck-overlap.svg" },
  { id: "v-neck-triangle", label: "V-Triangle",   file: "V-Neck-Triangle-Base.png", svgFile: "v-neck-triangle.svg", trimFile: "trim-v-neck.svg" },
  { id: "wishbone",        label: "Wishbone",     file: "Wishbone-Base.png",        svgFile: "wishbone.svg",        trimFile: "trim-wishbone.svg" },
  { id: "wnba",            label: "WNBA",         file: "WNBA-Base.png",            svgFile: "wnba.svg",            trimFile: "trim-wnba.svg" },
];

const INITIAL_COLORS = {
  body:     "#808080",
  panels:   "#808080",
  collar:   "#808080",
  inner:    "#808080",
  cuffs:    "#808080",
  triangle: "#212121",
};


const STRIPE_PATTERNS = [
  { id: "none",       label: "None" },
  { id: "single",     label: "Single" },
  { id: "double",     label: "Double" },
  { id: "triple",     label: "Triple" },
  { id: "thick-thin", label: "Thick-Thin" },
  { id: "chevron",    label: "Chevron" },
];

const BLEND_MODES = ["multiply", "overlay", "screen", "normal"];

// Jersey outline path extracted from map-jersey.ai (1000x1000 coordinate space)
const JERSEY_OUTLINE_PATH = "M 636.91 272.07 C 636.84 242.98 641.46 215.61 651.11 188.37 C 646.31 184.58 641.34 182.48 636.2 181.06 C 631.12 179.65 626.27 177.46 621.3 174.75 L 606.93 166.92 C 606.23 165.53 604.46 164.29 602.57 163.47 L 591.95 158.91 C 589.86 158.02 587.94 158.59 586.2 161.24 C 576.1 176.66 562.51 187.78 544.71 193.99 C 514.04 204.7 479.85 203.87 449.85 191.45 C 418.21 178.34 413.1 155.17 408.97 156.92 L 397.72 161.7 C 395.59 162.61 394.03 163.88 393.08 165.09 C 383.66 170.74 374.24 176.49 363.76 179.9 C 358.61 181.57 352.94 182.02 348.46 186.94 C 357.09 206.48 360.44 226.52 364.03 247.07 C 367.84 268.86 368.27 289.56 363.51 311.27 C 353.78 355.61 330.79 397.79 282.4 407.37 C 281.72 413.55 282.73 419.22 282.97 424.65 L 283.8 444.13 C 285.82 491.6 289.34 538.24 289.98 586.01 C 290.76 644.47 294.45 701.65 296.25 759.88 L 297.88 812.88 L 299.35 829.02 C 301.0 847.03 301.4 864.5 301.0 882.0 C 299.42 894.98 301.42 908.35 304.88 921.35 L 356.09 913.76 C 382.83 909.8 408.93 907.22 435.98 907.1 C 444.0 907.06 451.25 908.47 459.0 909.7 C 468.68 911.24 478.14 911.85 488.13 912.06 L 579.02 913.93 C 616.8 914.71 653.14 918.03 691.09 921.17 C 695.06 905.19 694.71 888.75 694.0 873.0 C 694.83 867.23 695.2 861.22 695.52 854.9 L 697.91 807.95 L 699.53 763.03 L 702.12 699.95 L 707.08 596.98 L 714.21 480.17 L 715.81 448.06 L 716.95 424.93 L 717.57 407.97 C 662.37 391.92 637.02 323.18 636.91 272.07 Z";

const PINSTRIPE_PATTERNS = [
  { id: "vertical",  label: "Vertical" },
  { id: "diagonal",  label: "Diagonal" },
  { id: "wide",      label: "Wide" },
];

// Logo zones — rx/ry are positions on the 1000x1000 canvas (fractions)
// Sponsor = wearer's left chest = screen right
// Manufacturer = wearer's right chest = screen left
const LOGO_ZONES = [
  { id: "main",         label: "Main Logo",    rx: 0.499, ry: 0.46,  defaultSize: 0.56,  blendMode: "normal",   opacity: 1.0 },
  { id: "sponsor",      label: "Sponsor",      rx: 0.584, ry: 0.315, defaultSize: 0.15,  blendMode: "normal",   opacity: 1.0 },
  { id: "manufacturer", label: "Manufacturer", rx: 0.414, ry: 0.315, defaultSize: 0.15,  blendMode: "normal",   opacity: 1.0 },
  { id: "inner-label",  label: "Inner Label",  rx: 0.499, ry: 0.245, defaultSize: 0.10,  blendMode: "normal",   opacity: 1.0 },
];

// Pixel-accurate zone coordinates derived from image analysis (1000x1000 canvas)
const Z = {
  jLeft: 0.281, jRight: 0.717, jTop: 0.156, jBot: 0.921, cx: 0.499,
  sLeft: 0.365, sRight: 0.634,
  bodyTop: 0.42,
  pLeft: 0.400, pRight: 0.650,
  bindW: 0.022,
  colTop: 0.158, colBot: 0.30,
};


// ── TRIM STRIPE RENDERER ────────────────────────────────────────────────────────
// Draws stripes on collar and cuffs zones, clipped to each zone path from the SVG map.
// Patterns: single, double, triple — parallel bands inset from the outer edge.

function drawTrimStripes(ctx, canvasSize, trim, trimSvgData) {
  if (!trim || !trim.enabled || !trimSvgData) return;
  const { colors, opacity } = trim;

  const JERSEY = { left: 281, top: 156, right: 717, bottom: 921 };
  const jerseyW = JERSEY.right - JERSEY.left;
  const jerseyH = JERSEY.bottom - JERSEY.top;
  const { viewBox, paths } = trimSvgData;
  const scale = Math.min(jerseyW / viewBox.w, jerseyH / viewBox.h);
  const offsetX = JERSEY.left + (jerseyW - viewBox.w * scale) / 2;
  const offsetY = JERSEY.top  + (jerseyH - viewBox.h * scale) / 2;
  const ds = canvasSize / 1000;

  // Helper to fill a single path
  const fillPath = (pathStr, color) => {
    ctx.save();
    ctx.translate(offsetX * ds, offsetY * ds);
    ctx.scale(scale * ds, scale * ds);
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    ctx.fill(new Path2D(pathStr));
    ctx.restore();
  };

  const isEnabled = (zone) => trim.enabled_zones?.[zone] !== false;
  const hasOverlap = Object.keys(paths).some(k => k.endsWith("1"));

  if (hasOverlap) {
    // ── V-NECK OVERLAP ────────────────────────────────────────────────────
    // Cuffs + panels: standard inner → outer → piping → middle
    ["cuffs", "panels"].forEach(prefix => {
      ["inner", "outer", "piping", "middle"].forEach(stripe => {
        const z = `${prefix}-${stripe}`;
        if (paths[z] && isEnabled(z)) fillPath(paths[z], colors[z]);
      });
    });

    // Collar under-flap (1 zones) bottom to top: inner1 → outer1 → piping1 → middle1
    ["inner", "outer", "piping", "middle"].forEach(stripe => {
      const z1   = `collar-${stripe}1`;
      const base = `collar-${stripe}`;
      if (paths[z1] && isEnabled(base)) fillPath(paths[z1], colors[base]);
    });

    // Collar over-flap on top: inner → outer → piping → middle
    ["inner", "outer", "piping", "middle"].forEach(stripe => {
      const z = `collar-${stripe}`;
      if (paths[z] && isEnabled(z)) fillPath(paths[z], colors[z]);
    });

  } else {
    // ── ALL OTHER COLLARS — inner → outer → piping → middle ───────────────
    ["collar", "cuffs", "panels"].forEach(prefix => {
      ["inner", "outer", "piping", "middle"].forEach(stripe => {
        const z = `${prefix}-${stripe}`;
        if (paths[z] && isEnabled(z)) fillPath(paths[z], colors[z]);
      });
    });
  }
}

// ── PATTERN IMAGE RENDERER ───────────────────────────────────────────────────────
// Draws an uploaded pattern image clipped to body + panels zones.
function drawPatternImage(ctx, canvasSize, patternImage, patternOpacity, svgData, patternTransform) {
  if (!patternImage || !svgData) return;
  const { paths, viewBox } = svgData;
  const JERSEY = { left: 281, top: 156, right: 717, bottom: 921 };
  const jerseyW = JERSEY.right - JERSEY.left;
  const jerseyH = JERSEY.bottom - JERSEY.top;
  const svgScale = Math.min(jerseyW / viewBox.w, jerseyH / viewBox.h);
  const svgOffX = JERSEY.left + (jerseyW - viewBox.w * svgScale) / 2;
  const svgOffY = JERSEY.top  + (jerseyH - viewBox.h * svgScale) / 2;
  const ds = canvasSize / 1000;

  const { scaleX=1, scaleY=1, offsetX=0, offsetY=0, rotation=0 } = patternTransform || {};

  // Jersey center in canvas px — pivot point for transforms
  const jL = JERSEY.left * ds, jT = JERSEY.top * ds;
  const jW = jerseyW * ds,     jH = jerseyH * ds;
  const cx = jL + jW / 2;
  const cy = jT + jH / 2;

  // Image draw dimensions
  const imgW = jW * scaleX;
  const imgH = jH * scaleY;

  // Draw into offscreen clipped to body + panels
  const off = document.createElement("canvas");
  off.width = canvasSize; off.height = canvasSize;
  const offCtx = off.getContext("2d");

  ["body", "panels"].forEach(zone => {
    const pathStr = paths[zone];
    if (!pathStr) return;
    offCtx.save();

    // Apply clip
    offCtx.translate(svgOffX * ds, svgOffY * ds);
    offCtx.scale(svgScale * ds, svgScale * ds);
    offCtx.beginPath();
    offCtx.clip(new Path2D(pathStr));
    offCtx.scale(1 / (svgScale * ds), 1 / (svgScale * ds));
    offCtx.translate(-svgOffX * ds, -svgOffY * ds);

    // Apply transforms: pivot at jersey center, then offset
    offCtx.translate(cx + offsetX * jW, cy + offsetY * jH);
    offCtx.rotate(rotation * Math.PI / 180);
    offCtx.scale(scaleX, scaleY);
    offCtx.drawImage(patternImage, -jW / 2, -jH / 2, jW, jH);

    offCtx.restore();
  });

  ctx.save();
  ctx.globalAlpha = patternOpacity;
  ctx.drawImage(off, 0, 0);
  ctx.restore();
}

// ── PINSTRIPE RENDERER ──────────────────────────────────────────────────────────

// Draws pinstripes clipped to the jersey outline.
// Layer order: BELOW logos and BELOW collar/cuffs/inner zones — i.e. on top of body only.
function drawPinstripes(ctx, canvasSize, stripes) {
  if (!stripes.enabled) return;
  const { color, pattern, spacing, width, opacity } = stripes;

  const cx = canvasSize * 0.501; // horizontal center aligned with collar point
  const sp = Math.max(3, spacing * (canvasSize / 1000) * 4);

  ctx.save();

  // Clip to jersey outline only — collar/cuffs/inner SVG zones are drawn
  // ON TOP of pinstripes in the render stack, so they naturally cover stripe overlap
  const scale = canvasSize / 1000;
  ctx.scale(scale, scale);
  ctx.clip(new Path2D(JERSEY_OUTLINE_PATH));
  ctx.scale(1/scale, 1/scale);

  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "butt";

  const S = canvasSize;

  if (pattern === "vertical") {
    // Stripes radiate outward from center — never on centerline
    // First stripe on each side starts at sp/2 from center
    for (let offset = sp / 2; cx - offset > 200; offset += sp) {
      // Left side
      ctx.beginPath();
      ctx.moveTo(cx - offset, 0);
      ctx.lineTo(cx - offset, S);
      ctx.stroke();
      // Right side (mirror)
      ctx.beginPath();
      ctx.moveTo(cx + offset, 0);
      ctx.lineTo(cx + offset, S);
      ctx.stroke();
    }
  } else if (pattern === "diagonal") {
    // Same symmetric approach for diagonal — radiate from center diagonal
    for (let offset = sp / 2; offset < S * 1.5; offset += sp) {
      ctx.beginPath();
      ctx.moveTo(cx - offset, 0);
      ctx.lineTo(cx - offset + S, S);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + offset, 0);
      ctx.lineTo(cx + offset - S, S);
      ctx.stroke();
    }
  } else if (pattern === "wide") {
    // Wide stripes — same symmetric approach
    const stripeW = sp * 0.4;
    ctx.fillStyle = color;
    for (let offset = sp / 2; cx - offset > 200; offset += sp) {
      ctx.fillRect(cx - offset - stripeW / 2, 0, stripeW, S);
      ctx.fillRect(cx + offset - stripeW / 2, 0, stripeW, S);
    }
  }

  ctx.restore();
}


// ── SVG ZONE RENDERER ──────────────────────────────────────────────────────────

function _drawSVGZoneSet(ctx, canvasSize, svgData, colors, zones) {
  if (!svgData) return;
  const { paths, viewBox } = svgData;
  const JERSEY = { left: 281, top: 156, right: 717, bottom: 921 };
  const jerseyW = JERSEY.right - JERSEY.left;
  const jerseyH = JERSEY.bottom - JERSEY.top;
  const scale = Math.min(jerseyW / viewBox.w, jerseyH / viewBox.h);
  const offsetX = JERSEY.left + (jerseyW - viewBox.w * scale) / 2;
  const offsetY = JERSEY.top  + (jerseyH - viewBox.h * scale) / 2;
  const displayScale = canvasSize / 1000;
  ctx.save();
  ctx.translate(offsetX * displayScale, offsetY * displayScale);
  ctx.scale(scale * displayScale, scale * displayScale);
  zones.forEach(zone => {
    const pathStr = paths[zone];
    const color = colors[zone];
    if (!pathStr || !color) return;
    ctx.fillStyle = color;
    ctx.fill(new Path2D(pathStr));
  });
  ctx.restore();
}

// Base zones drawn first (under pinstripes)
function drawSVGZonesBase(ctx, canvasSize, svgData, colors) {
  _drawSVGZoneSet(ctx, canvasSize, svgData, colors, ["body", "panels"]);
}

// Top zones drawn after pinstripes (collar/cuffs/inner cover stripe overlap)
function drawSVGZonesTop(ctx, canvasSize, svgData, colors) {
  _drawSVGZoneSet(ctx, canvasSize, svgData, colors, ["inner", "collar", "cuffs"]);
}

// Triangle insert — drawn last, above collar and trim stripes
function drawSVGZonesTriangle(ctx, canvasSize, svgData, colors) {
  _drawSVGZoneSet(ctx, canvasSize, svgData, colors, ["triangle"]);
}

// Legacy combined — used by export
function drawSVGZones(ctx, canvasSize, svgData, colors) {
  _drawSVGZoneSet(ctx, canvasSize, svgData, colors, ["body", "panels", "inner", "collar", "cuffs", "triangle"]);
}

// ── JERSEY CANVAS ──────────────────────────────────────────────────────────────

function JerseyCanvas({ colors, logos, activeZone, selectedLogoIdx, onZoneClick, onLogoMove, onDeselect, onRemoveLogo, onSelectLogo, jerseyImage, svgData, brightness, stripes, trim, trimSvgData, patternImage, patternOpacity, patternTransform }) {
  const canvasRef = useRef(null);
  const SZ = 1000;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, SZ, SZ);

    // 1. Base zones (body + panels)
    drawSVGZonesBase(ctx, SZ, svgData, colors);

    // 1a. Pattern image — over body color, under pinstripes
    drawPatternImage(ctx, SZ, patternImage, patternOpacity, svgData, patternTransform);

    // 1b. Pinstripes — on top of body/panels, under collar/cuffs/inner
    drawPinstripes(ctx, SZ, stripes);

    // 1c. Top zones (collar, cuffs, inner)
    drawSVGZonesTop(ctx, SZ, svgData, colors);

    // 1d. Trim stripes
    drawTrimStripes(ctx, SZ, trim, trimSvgData);

    // 1e. Triangle insert
    drawSVGZonesTriangle(ctx, SZ, svgData, colors);

    // 2a. Inner-label logos — drawn AFTER top zones but clipped to top inner path
    // so visible inside collar interior but masked by collar shape edges
    logos.forEach((logo) => {
      if (!logo.image || logo.zone !== "inner-label") return;
      if (!svgData?.paths?.inner) return;
      const JERSEY = { left:281, top:156, right:717, bottom:921 };
      const jerseyW = JERSEY.right - JERSEY.left, jerseyH = JERSEY.bottom - JERSEY.top;
      const svgScale = Math.min(jerseyW / svgData.viewBox.w, jerseyH / svgData.viewBox.h);
      const svgOffX = JERSEY.left + (jerseyW - svgData.viewBox.w * svgScale) / 2;
      const svgOffY = JERSEY.top  + (jerseyH - svgData.viewBox.h * svgScale) / 2;
      const ds = SZ / 1000;
      const subpaths = svgData.paths.inner.split(/(?=M)/).map(s=>s.trim()).filter(Boolean);
      const topPath = subpaths.length > 1
        ? subpaths.slice().sort((a,b) => parseFloat(a.match(/[\d.]+/g)?.[1]||999) - parseFloat(b.match(/[\d.]+/g)?.[1]||999))[0]
        : svgData.paths.inner;
      const lx = (logo.rx||0.499)*SZ, ly = (logo.ry||0.245)*SZ, size = logo.size*SZ*0.32;
      const ar = logo.image.naturalWidth / logo.image.naturalHeight;
      const dw = ar >= 1 ? size : size * ar;
      const dh = ar >= 1 ? size / ar : size;
      ctx.save();
      ctx.translate(svgOffX * ds, svgOffY * ds);
      ctx.scale(svgScale * ds, svgScale * ds);
      ctx.clip(new Path2D(topPath));
      ctx.scale(1/(svgScale * ds), 1/(svgScale * ds));
      ctx.translate(-svgOffX * ds, -svgOffY * ds);
      ctx.globalAlpha = logo.opacity;
      ctx.drawImage(logo.image, lx-dw/2, ly-dh/2, dw, dh);
      ctx.restore();
    });

    // 2b. All other logos — above collar zones, below jersey texture
    logos.forEach((logo) => {
      if (!logo.image || logo.zone === "inner-label") return;
      const lx = (logo.rx||0.499)*SZ, ly = (logo.ry||0.52)*SZ, size = logo.size*SZ*0.32;
      ctx.save();
      ctx.globalAlpha = logo.opacity;
      ctx.globalCompositeOperation = "source-over";
      (() => {
        const ar = logo.image.naturalWidth / logo.image.naturalHeight;
        const dw = ar >= 1 ? size : size * ar;
        const dh = ar >= 1 ? size / ar : size;
        ctx.drawImage(logo.image, lx-dw/2, ly-dh/2, dw, dh);
      })();
      ctx.restore();
    });

    // 3. Jersey PNG on top with multiply — fabric texture burns through
    if (jerseyImage) {
      ctx.save();
      ctx.globalAlpha = brightness;
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(jerseyImage, 0, 0, SZ, SZ);
      ctx.restore();
    }

    // 4. Selected logo indicator — dashed ring + × handle
    if (selectedLogoIdx !== null && logos[selectedLogoIdx]) {
      const logo = logos[selectedLogoIdx];
      const lx = (logo.rx||0.499)*SZ, ly = (logo.ry||0.52)*SZ;
      const radius = logo.size*SZ*0.32/2 + 10;
      ctx.save();
      // Dashed ring
      ctx.strokeStyle = "#efff00"; ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(lx, ly, radius, 0, Math.PI*2);
      ctx.stroke(); ctx.setLineDash([]);
      // × handle in top-right of ring
      const hx = lx + radius * 0.72, hy = ly - radius * 0.72;
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#ef4444";
      ctx.beginPath(); ctx.arc(hx, hy, 14, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5; ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.moveTo(hx-5, hy-5); ctx.lineTo(hx+5, hy+5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hx+5, hy-5); ctx.lineTo(hx-5, hy+5); ctx.stroke();
      ctx.restore();
    }
  }, [colors, logos, activeZone, selectedLogoIdx, jerseyImage, svgData, brightness, stripes, trim, trimSvgData, patternImage, patternOpacity, patternTransform]);

  const draggingRef = useRef(null);

  const handleMouseDown = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (SZ / rect.width);
    const my = (e.clientY - rect.top)  * (SZ / rect.height);

    // Check if clicking the × delete handle on selected logo
    if (selectedLogoIdx !== null && logos[selectedLogoIdx]) {
      const logo = logos[selectedLogoIdx];
      const lx = (logo.rx||0.499)*SZ, ly = (logo.ry||0.52)*SZ;
      const radius = logo.size*SZ*0.32/2 + 10;
      const hx = lx + radius * 0.72, hy = ly - radius * 0.72;
      if (Math.hypot(mx-hx, my-hy) < 16) {
        onRemoveLogo(selectedLogoIdx);
        return;
      }
    }

    // Check if clicking near any logo
    let hitIdx = -1;
    logos.forEach((logo, i) => {
      const lx = (logo.rx||0.499)*SZ, ly = (logo.ry||0.52)*SZ;
      const size = logo.size*SZ*0.32;
      if (Math.abs(mx-lx) < size/2 && Math.abs(my-ly) < size/2) hitIdx = i;
    });

    if (hitIdx >= 0) {
      draggingRef.current = { idx: hitIdx, startX: mx, startY: my };
      onSelectLogo(hitIdx);
    }
  }, [logos, selectedLogoIdx, onZoneClick, onRemoveLogo, onSelectLogo]);

  const handleMouseMove = useCallback((e) => {
    if (!draggingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (SZ / rect.width);
    const my = (e.clientY - rect.top)  * (SZ / rect.height);
    const { idx } = draggingRef.current;
    onLogoMove(idx, mx/SZ, my/SZ);
  }, [onLogoMove]);

  const handleMouseUp = useCallback(() => {
    draggingRef.current = null;
  }, []);

  const handleClick = useCallback((e) => {
    if (draggingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (SZ / rect.width);
    const my = (e.clientY - rect.top)  * (SZ / rect.height);
    // Check if clicking a placed logo
    let hitLogo = false;
    logos.forEach((logo, i) => {
      const lx = (logo.rx||0.499)*SZ, ly = (logo.ry||0.52)*SZ;
      const radius = logo.size*SZ*0.32/2 + 12;
      if (Math.hypot(mx-lx, my-ly) < radius) hitLogo = true;
    });
    if (!hitLogo) {
      onDeselect();
      return;
    }
  }, [logos, onDeselect]);

  return (
    <canvas ref={canvasRef} width={SZ} height={SZ}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ width: "100%", height: "auto", display: "block", cursor: draggingRef.current ? "grabbing" : "crosshair" }} />
  );
}

// ── UI COMPONENTS ──────────────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return <div style={{ fontSize: 9, fontWeight: 700, color: "#6b7280", letterSpacing: "0.12em", marginBottom: 10, textTransform: "uppercase" }}>{children}</div>;
}

function ColorSwatch({ color, onChange, label }) {
  const inputRef = useRef(null);
  const [hex, setHex] = React.useState(color.toUpperCase());
  React.useEffect(() => setHex(color.toUpperCase()), [color]);
  const onHexChange = (e) => {
    const v = e.target.value; setHex(v);
    const c = v.startsWith("#") ? v : "#"+v;
    if (/^#[0-9A-Fa-f]{6}$/.test(c)) onChange(c);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <button onClick={() => inputRef.current?.click()} style={{ width:30, height:30, borderRadius:6, border:"2px solid rgba(255,255,255,0.15)", background:color, cursor:"pointer", flexShrink:0, padding:0, boxShadow:"inset 0 0 0 1px rgba(0,0,0,0.3)" }} />
      <input ref={inputRef} type="color" value={color} onChange={e => onChange(e.target.value)} style={{ position:"absolute", opacity:0, width:0, height:0 }} />
      <span style={{ fontSize:12, color:"#9ca3af", flex:1 }}>{label}</span>
      <input type="text" value={hex} onChange={onHexChange} onBlur={() => setHex(color.toUpperCase())} maxLength={7} spellCheck={false}
        style={{ width:70, fontSize:11, fontFamily:"monospace", background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.15)", borderRadius:4, padding:"3px 6px", color:"#e2e8f0", textAlign:"center", outline:"none" }} />
    </div>
  );
}

function StripePreview({ pattern, sc }) {
  if (pattern === "none") return <div style={{ width:48, height:10, background:"rgba(255,255,255,0.06)", borderRadius:2 }} />;
  const c1=sc.primary||"#fff", c2=sc.secondary||"#000", c3=sc.tertiary||"#fff";
  const segs = ({single:[[c1,1]],double:[[c1,1],[c2,1]],triple:[[c1,1],[c2,1],[c3,1]],"thick-thin":[[c1,3],[c2,1]],chevron:[[c1,2],[c2,1],[c1,2]]})[pattern]||[];
  return (
    <div style={{ display:"flex", width:48, height:10, borderRadius:2, overflow:"hidden", border:"1px solid rgba(255,255,255,0.1)" }}>
      {segs.map(([c,f],i) => <div key={i} style={{ flex:f, background:c }} />)}
    </div>
  );
}

// ── MAIN APP ───────────────────────────────────────────────────────────────────

export default function JerseyCustomizer() {
  const [colors, setColors]               = useState(INITIAL_COLORS);
  const [collar, setCollar]               = useState(COLLAR_OPTIONS[0]);
  const [jerseyImage, setJerseyImage]     = useState(null);
  const [svgData, setSvgData]             = useState(null);
  const [stripePattern, setStripePattern] = useState("none");
  const [stripeColors, setStripeColors]   = useState({ primary:"#ffffff", secondary:"#efff00", tertiary:"#ffffff" });
  const [logos, setLogos]                 = useState([]);
  const [activeZone, setActiveZone]       = useState("chest");
  const [selectedLogoIdx, setSelectedLogoIdx] = useState(null);
  const [activeTab, setActiveTab]         = useState("collar");
  // ── AUTH + CREDITS (Clerk + Supabase) ──
  const { user, isLoaded, isSignedIn } = useUser();
  const { openSignIn } = useClerk();
  const [credits, setCredits]           = useState(0);
  const [paidCredits, setPaidCredits]   = useState(0);
  const [isUnlimited, setIsUnlimited]   = useState(false);
  const [hasWatermark, setHasWatermark] = useState(true);
  const [creditsLoaded, setCreditsLoaded] = useState(false);
  const [exporting, setExporting]         = useState(false);
  const [exported, setExported]           = useState(false);
  const [showUpgrade, setShowUpgrade]     = useState(false);
  const [selectedPlan, setSelectedPlan]   = useState(null);
  const [brightness, setBrightness]         = useState(0.72);
  const [hideControls, setHideControls]     = useState(false);
  const [bg, setBg] = useState({ enabled: true, color: "#ffffff" });
  const [trimSvgData, setTrimSvgData]       = useState(null);
  const [trim, setTrim] = useState({
    enabled: false,
    colors: {
      "cuffs-inner":   "#212121",
      "cuffs-outer":   "#212121",
      "cuffs-piping":  "#efff00",
      "cuffs-middle":  "#fcfcfc",
      "collar-inner":  "#212121",
      "collar-outer":  "#212121",
      "collar-piping": "#efff00",
      "collar-middle": "#fcfcfc",
      "panels-inner":  "#212121",
      "panels-outer":  "#212121",
      "panels-piping": "#efff00",
      "panels-middle": "#fcfcfc",
    },
    enabled_zones: {
      "cuffs-inner":   true,
      "cuffs-outer":   true,
      "cuffs-piping":  true,
      "cuffs-middle":  true,
      "collar-inner":  true,
      "collar-outer":  true,
      "collar-piping": true,
      "collar-middle": true,
      "panels-inner":  true,
      "panels-outer":  true,
      "panels-piping": true,
      "panels-middle": true,
    },
    opacity: 1.0,
  });
  const [patternImage, setPatternImage]     = useState(null);
  const [patternOpacity, setPatternOpacity] = useState(1.0);
  const [patternTransform, setPatternTransform] = useState({
    scaleX: 1.0,   // horizontal stretch
    scaleY: 1.0,   // vertical stretch
    offsetX: 0,    // x position offset (-1 to 1 as fraction of jersey width)
    offsetY: 0,    // y position offset
    rotation: 0,   // degrees
  });
  const patternFileRef                    = useRef(null);
  const [stripes, setStripes] = useState({
    enabled: false,
    color: "#808080",
    pattern: "vertical",
    spacing: 6,
    width: 2,
    opacity: 0.70,
  });
  const [zoom, setZoom]                     = useState(1.5);
  const [pan, setPan]                       = useState({ x: 0, y: 0 });
  const isPanning                           = useRef(false);
  const spaceHeld                           = useRef(false);
  const [spaceActive, setSpaceActive]       = useState(false);
  const [panningActive, setPanningActive]   = useState(false);
  const panStart                            = useRef({ x: 0, y: 0 });
  const panOrigin                           = useRef({ x: 0, y: 0 });
  const centerRef                           = useRef(null);
  const fileRef = useRef(null);

  // ── Load credits from Supabase on sign-in ──
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { setCredits(0); setCreditsLoaded(true); return; }
    fetch('/api/user/credits')
      .then(r => r.json())
      .then(data => {
        console.log('Credits loaded:', data);
        setCredits(data.totalCredits || 0);
        setPaidCredits(data.paidCredits || 0);
        setIsUnlimited(data.isUnlimited || false);
        setHasWatermark(data.hasWatermark !== false);
        setCreditsLoaded(true);
      })
      .catch(err => { console.error('Credits fetch error:', err); setCreditsLoaded(true); });
  }, [isLoaded, isSignedIn]);

  // Auto-open upgrade modal if redirected after sign-in via GET CREDITS
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('upgrade') === 'true' && isSignedIn) {
        setShowUpgrade(true);
        window.history.replaceState({}, '', '/');
      }
    }
  }, [isSignedIn]);

  // Load jersey PNG and SVG maps when collar changes
  useEffect(() => {
    const img = new Image();
    img.onload = () => setJerseyImage(img);
    img.src = `/${collar.file}`;
    // Load collar-specific trim SVG
    setTrimSvgData(null);
    fetch(`/${collar.trimFile || 'trim-u-neck.svg'}`)
      .then(r => { console.log('trim-cuffs fetch:', r.status, r.ok); return r.ok ? r.text() : null; })
      .then(svgText => {
        if (!svgText) return;
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, "text/html");
        const svgEl = doc.querySelector("svg");
        if (!svgEl) return;
        const vbAttr = svgEl.getAttribute("viewBox") || "0 0 435.397 764.519";
        const vbParts = vbAttr.split(/[\s,]+/).map(Number);
        const paths = {};
        doc.querySelectorAll("[id^='zone-']").forEach(el => {
          const zoneName = el.id.replace("zone-", "");
          if (el.tagName.toLowerCase() === "path") {
            paths[zoneName] = el.getAttribute("d");
          } else {
            const combined = Array.from(el.querySelectorAll("path")).map(p => p.getAttribute("d")).join(" ");
            if (combined) paths[zoneName] = combined;
          }
        });
        console.log("Trim zones loaded:", Object.keys(paths));
        setTrimSvgData({ paths, viewBox: { w: vbParts[2], h: vbParts[3] } });
      })
      .catch(() => {});

    // Load and parse SVG zone map
    setSvgData(null);
    fetch(`/${collar.svgFile}`)
      .then(r => {
        if (!r.ok) { console.error("SVG fetch failed:", r.status, collar.svgFile); return null; }
        return r.text();
      })
      .then(svgText => {
        if (!svgText) return;
        console.log("SVG text preview:", svgText.slice(0, 200));
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, "text/html");
        const svgEl = doc.querySelector("svg");
        if (!svgEl) { console.error("SVG element not found in:", svgText.slice(0, 100)); return; }
        const vbAttr = svgEl.getAttribute("viewBox") || "0 0 435.405 764.519";
        const vbParts = vbAttr.split(/[\s,]+/).map(Number);
        const paths = {};
        doc.querySelectorAll("[id^='zone-']").forEach(el => {
          const zoneName = el.id.replace("zone-", "");
          if (el.tagName.toLowerCase() === "path") {
            paths[zoneName] = el.getAttribute("d");
          } else {
            const combined = Array.from(el.querySelectorAll("path"))
              .map(p => p.getAttribute("d")).join(" ");
            if (combined) paths[zoneName] = combined;
          }
        });
        console.log("SVG zones loaded:", Object.keys(paths));
        setSvgData({ paths, viewBox: { w: vbParts[2], h: vbParts[3] } });
      })
      .catch(err => console.error("SVG load error:", err));
  }, [collar]);

  const setColor = (key, val) => setColors(c => ({ ...c, [key]: val }));


  const handleLogoUpload = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => setLogos(prev => { const zoneDef=LOGO_ZONES.find(z=>z.id===activeZone)||LOGO_ZONES[0]; const next=[...prev,{id:Date.now(),image:img,zone:activeZone,rx:zoneDef.rx,ry:zoneDef.ry,size:zoneDef.defaultSize,opacity:zoneDef.opacity,blendMode:"normal"}]; setSelectedLogoIdx(next.length-1); return next; });
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const updateLogo = (idx, upd) => setLogos(prev => prev.map((l,i) => i===idx ? {...l,...upd} : l));
  const removeLogo = (idx) => { setLogos(prev => prev.filter((_,i) => i!==idx)); setSelectedLogoIdx(null); };
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        spaceHeld.current = true;
        setSpaceActive(true);
      }
    };
    const onKeyUp = (e) => {
      if (e.code === "Space") {
        spaceHeld.current = false;
        setSpaceActive(false);
        // Do NOT stop panning here — let mouseUp handle that
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => Math.min(4, Math.max(0.5, Math.round((z + delta) * 10) / 10)));
  }, []);

  const handlePanStart = useCallback((e) => {
    if (e.button === 1 || spaceHeld.current) {
      isPanning.current = true;
      setPanningActive(true);
      panStart.current = { x: e.clientX, y: e.clientY };
      panOrigin.current = { ...pan };
      e.preventDefault();
    }
  }, [pan]);

  const handlePanMove = useCallback((e) => {
    if (!isPanning.current) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    setPan({ x: panOrigin.current.x + dx, y: panOrigin.current.y + dy });
  }, []);

  const handlePanEnd = useCallback(() => {
    isPanning.current = false;
    setPanningActive(false);
  }, []);

  const resetView = useCallback(() => {
    setZoom(1.5);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleLogoMove = useCallback((idx, rx, ry) => {
    setLogos(prev => prev.map((l,i) => i===idx ? {...l, rx, ry} : l));
  }, []);

  const handleExport = async () => {
    if (!isSignedIn) { openSignIn({ afterSignInUrl:"/?upgrade=true", afterSignUpUrl:"/?upgrade=true" }); return; }
    if (!isUnlimited && credits <= 0) { setShowUpgrade(true); return; }
    setExporting(true);

    // Validate + deduct credit server-side
    const exportRes = await fetch('/api/user/export', { method: 'POST' });
    const exportData = await exportRes.json();
    if (!exportData.allowed) {
      setExporting(false);
      setShowUpgrade(true);
      return;
    }
    // Update local state from server response
    const useWatermark = exportData.hasWatermark;
    setCredits(isUnlimited ? 999 : (exportData.freeCredits || 0) + (exportData.paidCredits || 0));
    setPaidCredits(exportData.paidCredits || 0);
    setHasWatermark(exportData.hasWatermark);

    await new Promise(r => setTimeout(r, 800));

    // Render clean export canvas — no selection ring
    const SZ = 1000;
    const off = document.createElement("canvas");
    off.width = SZ; off.height = SZ;
    const ctx = off.getContext("2d");

    // 0. Background image (if enabled)
    if (bg.enabled) {
      const bgImg = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = "/background.png";
      });
      if (bgImg) {
        ctx.drawImage(bgImg, 0, 0, SZ, SZ);
        if (bg.color !== "#ffffff" && bg.color !== "#FFFFFF") {
          ctx.save();
          ctx.globalCompositeOperation = "multiply";
          ctx.fillStyle = bg.color;
          ctx.fillRect(0, 0, SZ, SZ);
          ctx.restore();
        }
      }
    }

    // 1. Draw SVG color zones — base first, then stripes, then top zones
    if (svgData) drawSVGZonesBase(ctx, SZ, svgData, colors);

    // 1a. Pattern image
    drawPatternImage(ctx, SZ, patternImage, patternOpacity, svgData, patternTransform);

    // 1b. Pinstripes
    drawPinstripes(ctx, SZ, stripes);

    // 1c. Top zones
    if (svgData) drawSVGZonesTop(ctx, SZ, svgData, colors);

    // 1d. Trim stripes
    drawTrimStripes(ctx, SZ, trim, trimSvgData);

    // 1e. Triangle insert
    if (svgData) drawSVGZonesTriangle(ctx, SZ, svgData, colors);

    // 2a. Inner-label — after top zones, clipped to top inner path
    logos.forEach((logo) => {
      if (!logo.image || logo.zone !== "inner-label") return;
      if (!svgData?.paths?.inner) return;
      const JERSEY = { left:281, top:156, right:717, bottom:921 };
      const jerseyW = JERSEY.right - JERSEY.left, jerseyH = JERSEY.bottom - JERSEY.top;
      const svgScale = Math.min(jerseyW / svgData.viewBox.w, jerseyH / svgData.viewBox.h);
      const svgOffX = JERSEY.left + (jerseyW - svgData.viewBox.w * svgScale) / 2;
      const svgOffY = JERSEY.top  + (jerseyH - svgData.viewBox.h * svgScale) / 2;
      const ds = SZ / 1000;
      const subpaths = svgData.paths.inner.split(/(?=M)/).map(s=>s.trim()).filter(Boolean);
      const topPath = subpaths.length > 1
        ? subpaths.slice().sort((a,b) => parseFloat(a.match(/[\d.]+/g)?.[1]||999) - parseFloat(b.match(/[\d.]+/g)?.[1]||999))[0]
        : svgData.paths.inner;
      const lx = (logo.rx||0.499)*SZ, ly = (logo.ry||0.245)*SZ, size = logo.size*SZ*0.32;
      const ar = logo.image.naturalWidth / logo.image.naturalHeight;
      const dw = ar >= 1 ? size : size * ar;
      const dh = ar >= 1 ? size / ar : size;
      ctx.save();
      ctx.translate(svgOffX * ds, svgOffY * ds);
      ctx.scale(svgScale * ds, svgScale * ds);
      ctx.clip(new Path2D(topPath));
      ctx.scale(1/(svgScale * ds), 1/(svgScale * ds));
      ctx.translate(-svgOffX * ds, -svgOffY * ds);
      ctx.globalAlpha = logo.opacity;
      ctx.drawImage(logo.image, lx-dw/2, ly-dh/2, dw, dh);
      ctx.restore();
    });

    // 2b. All other logos
    logos.forEach((logo) => {
      if (!logo.image || logo.zone === "inner-label") return;
      const lx = (logo.rx||0.499)*SZ, ly = (logo.ry||0.52)*SZ, size = logo.size*SZ*0.32;
      ctx.save();
      ctx.globalAlpha = logo.opacity;
      ctx.globalCompositeOperation = "source-over";
      (() => {
        const ar = logo.image.naturalWidth / logo.image.naturalHeight;
        const dw = ar >= 1 ? size : size * ar;
        const dh = ar >= 1 ? size / ar : size;
        ctx.drawImage(logo.image, lx-dw/2, ly-dh/2, dw, dh);
      })();
      ctx.restore();
    });

    // 3. Jersey texture on top
    if (jerseyImage) {
      ctx.save();
      ctx.globalAlpha = brightness;
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(jerseyImage, 0, 0, SZ, SZ);
      ctx.restore();
    }

    // 4. Watermark — only for free credit exports
    if (useWatermark) {
      try {
        const wm = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = "/ProLine-PFP-New.jpg";
        });
        ctx.save();
        ctx.globalAlpha = 0.02;
        ctx.globalCompositeOperation = "source-over";
        const wmSize = 160;
        const cols = Math.ceil(SZ / wmSize) + 1;
        const rows = Math.ceil(SZ / wmSize) + 1;
        for (let row = 0; row < rows; row++) {
          const xOffset = (row % 2 === 0) ? 0 : wmSize / 2;
          for (let col = 0; col < cols; col++) {
            ctx.drawImage(wm, col * wmSize - xOffset, row * wmSize, wmSize, wmSize);
          }
        }
        ctx.restore();
      } catch {
        // Fallback to text watermark
        ctx.save();
        ctx.globalAlpha = 0.02;
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 40px sans-serif";
        ctx.textAlign = "center";
        ctx.translate(SZ/2, SZ/2);
        ctx.rotate(-Math.PI / 6);
        for (let y = -700; y < 700; y += 220) {
          for (let x = -700; x < 700; x += 380) {
            ctx.fillText("PROLINEMOCKUPS.COM", x, y);
          }
        }
        ctx.restore();
      }
    }

    const a = document.createElement("a");
    a.href = off.toDataURL("image/png");
    a.download = `proline-${collar.id}.png`;
    a.click();
    setExporting(false); setExported(true);
    setTimeout(() => setExported(false), 2500);
  };

  const handleGetCredits = () => {
    if (!isSignedIn) { openSignIn({ afterSignInUrl:"/?upgrade=true", afterSignUpUrl:"/?upgrade=true" }); return; }
    setShowUpgrade(true);
  };

  const TABS = ["collar","colors","trim","pattern","logos"];
  const TAB_LABELS = { collar:"Collar", colors:"Colors", trim:"Trim", pattern:"Pattern", logos:"Logos" };

  return (
    <div style={{ fontFamily:"'Barlow','Arial Narrow',sans-serif", color:"#e2e8f0" }}>
      {/* Mobile block screen */}
      <div className="mobile-block" style={{ display:"none", position:"fixed", inset:0, background:"#1f1c1e", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:32, textAlign:"center", zIndex:9999 }}>
        <img src="/ProLine-PFP-New.jpg" alt="ProLine" style={{ width:64, height:64, borderRadius:14, marginBottom:24, objectFit:"cover" }} />
        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:24, letterSpacing:"0.06em", marginBottom:12 }}>JERSEY BUILDER</div>
        <div style={{ fontSize:14, color:"#9ca3af", lineHeight:1.7, maxWidth:300, marginBottom:28 }}>
          This tool is designed for desktop use. Please open it on a laptop or desktop computer for the best experience.
        </div>
        <a href="https://www.prolinemockups.com" style={{ background:"linear-gradient(135deg,#efff00,#c8d900)", borderRadius:8, padding:"12px 24px", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:13, letterSpacing:"0.06em", color:"#000", textDecoration:"none" }}>VISIT PROLINEMOCKUPS.COM</a>
      </div>

      {/* Desktop app */}
      <div className="desktop-app" style={{ display:"none", height:"100vh", height:"100dvh", maxHeight:"100vh", maxHeight:"100dvh", flexDirection:"column", overflow:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@600;700;800;900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0} html,body{height:100%;overflow:hidden}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:2px}
        input[type=range]{-webkit-appearance:none;width:100%;height:3px;background:rgba(255,255,255,0.12);border-radius:2px;outline:none;cursor:pointer}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;background:#efff00;cursor:pointer}
        @keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
        @media (max-width: 768px) {
          .mobile-block { display: flex !important; }
          .desktop-app  { display: none  !important; }
        }
        @media (min-width: 769px) {
          .mobile-block { display: none  !important; }
          .desktop-app  { display: flex  !important; }
        }
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
        .fade{animation:fadeIn 0.18s ease}
        .hov:hover{border-color:rgba(239,255,0,0.4)!important}
      `}</style>

      {/* TOP BAR */}
      <div style={{ background:"#161314", borderBottom:"1px solid rgba(255,255,255,0.07)", padding:"0 16px", display:"flex", alignItems:"center", justifyContent:"space-between", height:48, flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:9 }}>
          <img src="/ProLine-PFP-New.jpg" alt="ProLine" style={{ width:26, height:26, borderRadius:6, objectFit:"cover", display:"block" }} />
          <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:15, letterSpacing:"0.06em", color:"#fff" }}>JERSEY BUILDER</span>
          <span style={{ background:"rgba(239,255,0,0.12)", color:"#efff00", fontSize:9, fontWeight:700, padding:"2px 7px", borderRadius:4, letterSpacing:"0.08em", border:"1px solid rgba(239,255,0,0.25)", fontFamily:"'Barlow Condensed',sans-serif" }}>BETA</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          {isSignedIn && (
            <div style={{ display:"flex", alignItems:"center", gap:7, background:"rgba(255,255,255,0.05)", padding:"5px 11px", borderRadius:7, border:"1px solid rgba(255,255,255,0.08)" }}>
              <div style={{ width:7, height:7, borderRadius:"50%", background:credits>0?"#10b981":"#ef4444" }} />
              <span style={{ fontSize:11, color:"#9ca3af" }}>Credits:</span>
              <span style={{ fontSize:14, fontWeight:700, color:credits>0?"#f3f4f6":"#ef4444", fontFamily:"'Barlow Condensed',sans-serif" }}>{isUnlimited ? "∞" : credits}</span>
            </div>
          )}
          <button onClick={() => setHideControls(h => !h)} style={{ background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:6, padding:"6px 14px", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:12, letterSpacing:"0.05em", color:"#9ca3af", cursor:"pointer" }}>{hideControls ? "SHOW CONTROLS" : "HIDE CONTROLS"}</button>
          <button onClick={handleGetCredits} style={{ background:"linear-gradient(135deg,#efff00,#c8d900)", border:"none", borderRadius:6, padding:"6px 14px", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:12, letterSpacing:"0.05em", color:"#000", cursor:"pointer" }}>{isSignedIn ? "GET CREDITS" : "GET STARTED"}</button>
          {isSignedIn
            ? <UserButton afterSignOutUrl="/" appearance={{ elements: { avatarBox: { width:28, height:28 } } }} />
            : <button onClick={() => openSignIn({ afterSignInUrl:"/?upgrade=true" })} style={{ background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:"50%", width:28, height:28, cursor:"pointer", fontSize:12, color:"#e2e8f0", display:"flex", alignItems:"center", justifyContent:"center" }}>👤</button>
          }
        </div>
      </div>

      {/* LAYOUT */}
      <div style={{ display:"grid", gridTemplateColumns:hideControls?"0 1fr 0":"min(272px,22vw) 1fr min(252px,20vw)", flex:1, overflow:"hidden", transition:"grid-template-columns 0.3s ease", minHeight:0 }}>

        {/* LEFT */}
        <div style={{ background:"#161314", borderRight:"1px solid rgba(255,255,255,0.07)", display:"flex", flexDirection:"column", overflow:"hidden", visibility:hideControls?"hidden":"visible" }}>
          <div style={{ display:"flex", borderBottom:"1px solid rgba(255,255,255,0.07)", flexShrink:0 }}>
            {TABS.map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ flex:1, padding:"9px 0", fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.1em", textTransform:"uppercase", background:"none", border:"none", cursor:"pointer", color:activeTab===tab?"#efff00":"#6b7280", borderBottom:activeTab===tab?"2px solid #efff00":"2px solid transparent" }}>{TAB_LABELS[tab]}</button>
            ))}
          </div>

          <div style={{ flex:1, overflowY:"auto", padding:"14px", minHeight:0 }}>

            {activeTab === "colors" && (
              <div className="fade">
                <SectionLabel>Background</SectionLabel>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                  <span style={{ fontSize:12, color:"#9ca3af" }}>Show Background</span>
                  <button onClick={() => setBg(b=>({...b,enabled:!b.enabled}))} style={{ background:bg.enabled?"rgba(239,255,0,0.15)":"rgba(255,255,255,0.06)", border:bg.enabled?"1px solid rgba(239,255,0,0.5)":"1px solid rgba(255,255,255,0.12)", borderRadius:20, padding:"4px 14px", cursor:"pointer", fontSize:10, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:bg.enabled?"#efff00":"#6b7280", letterSpacing:"0.06em" }}>{bg.enabled?"ON":"OFF"}</button>
                </div>
                {bg.enabled && (
                  <div style={{ marginBottom:14 }}>
                    <ColorSwatch color={bg.color} onChange={v => setBg(b=>({...b,color:v}))} label="Background Tint" />
                    {bg.color !== "#ffffff" && bg.color !== "#FFFFFF" && (
                      <button onClick={() => setBg(b=>({...b,color:"#ffffff"}))} style={{ background:"none", border:"none", color:"#6b7280", cursor:"pointer", fontSize:10, padding:"2px 0", fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.04em" }}>✕ CLEAR TINT</button>
                    )}
                  </div>
                )}
                <div style={{ height:1, background:"rgba(255,255,255,0.06)", marginBottom:14 }} />
                                <SectionLabel>Brightness</SectionLabel>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
                  <span style={{ fontSize:10, color:"#6b7280" }}>Dark</span>
                  <input type="range" min="40" max="100" value={Math.round(brightness*100)} onChange={e => setBrightness(parseInt(e.target.value)/100)} style={{ flex:1 }} />
                  <span style={{ fontSize:10, color:"#6b7280" }}>Light</span>
                  <span style={{ fontSize:10, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:28, textAlign:"right" }}>{Math.round(brightness*100)}%</span>
                </div>
                <div style={{ height:1, background:"rgba(255,255,255,0.06)", marginBottom:14 }} />
                <SectionLabel>Zone Colors</SectionLabel>
                <ColorSwatch color={colors.body}     onChange={v => setColor("body",v)}     label="Main Body" />
                <ColorSwatch color={colors.panels}   onChange={v => setColor("panels",v)}   label="Side Panels" />
                <ColorSwatch color={colors.collar}   onChange={v => setColor("collar",v)}   label="Collar" />
                <ColorSwatch color={colors.inner}    onChange={v => setColor("inner",v)}    label="Inner" />
                <ColorSwatch color={colors.cuffs}    onChange={v => setColor("cuffs",v)}    label="Cuffs" />
                {collar.id === "v-neck-triangle" && (
                  <ColorSwatch color={colors.triangle} onChange={v => setColor("triangle",v)} label="V-Triangle Insert" />
                )}
              </div>
            )}

            {activeTab === "collar" && (
              <div className="fade">
                <SectionLabel>Collar Style</SectionLabel>
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {COLLAR_OPTIONS.map(c => (
                    <button key={c.id} className="hov" onClick={() => {
                        setCollar(c);
                        // Apply collar-specific trim color defaults
                        if (c.id === "wishbone") {
                          setTrim(t=>({...t, colors:{...t.colors,
                            "collar-outer":"#efff00",
                            "cuffs-inner":"#212121", "cuffs-piping":"#212121", "cuffs-middle":"#212121", "cuffs-outer":"#efff00",
                          }}));
                        } else if (c.id === "wnba") {
                          setTrim(t=>({...t, colors:{...t.colors,
                            "collar-inner":"#212121", "collar-outer":"#212121", "collar-middle":"#efff00",
                            "cuffs-inner":"#212121", "cuffs-piping":"#212121", "cuffs-middle":"#efff00", "cuffs-outer":"#212121",
                          }}));
                        }
                      }} style={{ background:collar.id===c.id?"rgba(239,255,0,0.1)":"rgba(255,255,255,0.04)", border:collar.id===c.id?"1px solid rgba(239,255,0,0.4)":"1px solid rgba(255,255,255,0.08)", borderRadius:8, padding:"12px 14px", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                      <span style={{ fontSize:13, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.05em", color:collar.id===c.id?"#efff00":"#d1d5db" }}>{c.label.toUpperCase()}</span>
                      {collar.id===c.id && <span style={{ fontSize:9, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700 }}>ACTIVE</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "trim" && (
              <div className="fade">
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
                  <SectionLabel>Trim Stripes</SectionLabel>
                  <button onClick={() => setTrim(t=>({...t,enabled:!t.enabled}))} style={{ background:trim.enabled?"rgba(239,255,0,0.15)":"rgba(255,255,255,0.06)", border:trim.enabled?"1px solid rgba(239,255,0,0.5)":"1px solid rgba(255,255,255,0.12)", borderRadius:20, padding:"3px 12px", cursor:"pointer", fontSize:10, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:trim.enabled?"#efff00":"#6b7280", letterSpacing:"0.06em" }}>{trim.enabled?"ON":"OFF"}</button>
                </div>
                {!trimSvgData && trim.enabled && (
                  <div style={{ fontSize:10, color:"#6b7280", marginBottom:14, padding:"8px 10px", background:"rgba(255,255,255,0.03)", borderRadius:6 }}>Loading trim map...</div>
                )}
                {trim.enabled && trimSvgData && (
                  <div className="fade">
                    {/* Collar */}
                    {["collar-outer","collar-middle","collar-piping","collar-inner"].some(z => trimSvgData.paths[z]) && (
                      <>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                          <SectionLabel>Collar</SectionLabel>
                          {(() => {
                            const grp = ["collar-outer","collar-middle","collar-piping","collar-inner"].filter(z => trimSvgData.paths[z]);
                            const allOn = grp.every(z => trim.enabled_zones?.[z] !== false);
                            return <button onClick={() => setTrim(t=>({...t,enabled_zones:{...t.enabled_zones,...Object.fromEntries(grp.map(z=>[z,!allOn]))}}))} style={{ background:allOn?"rgba(239,255,0,0.15)":"rgba(255,255,255,0.06)", border:allOn?"1px solid rgba(239,255,0,0.5)":"1px solid rgba(255,255,255,0.12)", borderRadius:20, padding:"3px 12px", cursor:"pointer", fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:allOn?"#efff00":"#6b7280", letterSpacing:"0.06em" }}>{allOn?"ON":"OFF"}</button>;
                          })()}
                        </div>
                        {["collar-outer","collar-middle","collar-piping","collar-inner"].map(zone => {
                          if (!trimSvgData.paths[zone]) return null;
                          const label = zone.replace("collar-","").charAt(0).toUpperCase() + zone.replace("collar-","").slice(1);
                          const isOn = trim.enabled_zones?.[zone] !== false;
                          return (
                            <div key={zone} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, opacity: isOn ? 1 : 0.4 }}>
                              <button onClick={() => setTrim(t=>({...t,enabled_zones:{...t.enabled_zones,[zone]:!isOn}}))} style={{ background:isOn?"rgba(239,255,0,0.15)":"rgba(255,255,255,0.06)", border:isOn?"1px solid rgba(239,255,0,0.4)":"1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"2px 8px", cursor:"pointer", fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:isOn?"#efff00":"#6b7280", flexShrink:0 }}>{isOn?"ON":"OFF"}</button>
                              <div style={{ flex:1 }}><ColorSwatch color={trim.colors[zone]||"#ffffff"} onChange={v => setTrim(t=>({...t,colors:{...t.colors,[zone]:v}}))} label={label} /></div>
                            </div>
                          );
                        })}
                        <div style={{ height:1, background:"rgba(255,255,255,0.06)", marginBottom:14, marginTop:4 }} />
                      </>
                    )}
                    {/* Cuffs */}
                    {["cuffs-outer","cuffs-middle","cuffs-piping","cuffs-inner"].some(z => trimSvgData.paths[z]) && (
                      <>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                          <SectionLabel>Cuffs</SectionLabel>
                          {(() => {
                            const grp = ["cuffs-outer","cuffs-middle","cuffs-piping","cuffs-inner"].filter(z => trimSvgData.paths[z]);
                            const allOn = grp.every(z => trim.enabled_zones?.[z] !== false);
                            return <button onClick={() => setTrim(t=>({...t,enabled_zones:{...t.enabled_zones,...Object.fromEntries(grp.map(z=>[z,!allOn]))}}))} style={{ background:allOn?"rgba(239,255,0,0.15)":"rgba(255,255,255,0.06)", border:allOn?"1px solid rgba(239,255,0,0.5)":"1px solid rgba(255,255,255,0.12)", borderRadius:20, padding:"3px 12px", cursor:"pointer", fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:allOn?"#efff00":"#6b7280", letterSpacing:"0.06em" }}>{allOn?"ON":"OFF"}</button>;
                          })()}
                        </div>
                        {["cuffs-outer","cuffs-middle","cuffs-piping","cuffs-inner"].map(zone => {
                          if (!trimSvgData.paths[zone]) return null;
                          const label = zone.replace("cuffs-","").charAt(0).toUpperCase() + zone.replace("cuffs-","").slice(1);
                          const isOn = trim.enabled_zones?.[zone] !== false;
                          return (
                            <div key={zone} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, opacity: isOn ? 1 : 0.4 }}>
                              <button onClick={() => setTrim(t=>({...t,enabled_zones:{...t.enabled_zones,[zone]:!isOn}}))} style={{ background:isOn?"rgba(239,255,0,0.15)":"rgba(255,255,255,0.06)", border:isOn?"1px solid rgba(239,255,0,0.4)":"1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"2px 8px", cursor:"pointer", fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:isOn?"#efff00":"#6b7280", flexShrink:0 }}>{isOn?"ON":"OFF"}</button>
                              <div style={{ flex:1 }}><ColorSwatch color={trim.colors[zone]||"#ffffff"} onChange={v => setTrim(t=>({...t,colors:{...t.colors,[zone]:v}}))} label={label} /></div>
                            </div>
                          );
                        })}
                        <div style={{ height:1, background:"rgba(255,255,255,0.06)", marginBottom:14, marginTop:4 }} />
                      </>
                    )}
                    {/* Side Panels */}
                    {["panels-outer","panels-middle","panels-piping","panels-inner"].some(z => trimSvgData.paths[z]) && (
                      <>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                          <SectionLabel>Side Panels</SectionLabel>
                          {(() => {
                            const grp = ["panels-outer","panels-middle","panels-piping","panels-inner"].filter(z => trimSvgData.paths[z]);
                            const allOn = grp.every(z => trim.enabled_zones?.[z] !== false);
                            return <button onClick={() => setTrim(t=>({...t,enabled_zones:{...t.enabled_zones,...Object.fromEntries(grp.map(z=>[z,!allOn]))}}))} style={{ background:allOn?"rgba(239,255,0,0.15)":"rgba(255,255,255,0.06)", border:allOn?"1px solid rgba(239,255,0,0.5)":"1px solid rgba(255,255,255,0.12)", borderRadius:20, padding:"3px 12px", cursor:"pointer", fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:allOn?"#efff00":"#6b7280", letterSpacing:"0.06em" }}>{allOn?"ON":"OFF"}</button>;
                          })()}
                        </div>
                        {["panels-outer","panels-middle","panels-piping","panels-inner"].map(zone => {
                          if (!trimSvgData.paths[zone]) return null;
                          const label = zone.replace("panels-","").charAt(0).toUpperCase() + zone.replace("panels-","").slice(1);
                          const isOn = trim.enabled_zones?.[zone] !== false;
                          return (
                            <div key={zone} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, opacity: isOn ? 1 : 0.4 }}>
                              <button onClick={() => setTrim(t=>({...t,enabled_zones:{...t.enabled_zones,[zone]:!isOn}}))} style={{ background:isOn?"rgba(239,255,0,0.15)":"rgba(255,255,255,0.06)", border:isOn?"1px solid rgba(239,255,0,0.4)":"1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"2px 8px", cursor:"pointer", fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:isOn?"#efff00":"#6b7280", flexShrink:0 }}>{isOn?"ON":"OFF"}</button>
                              <div style={{ flex:1 }}><ColorSwatch color={trim.colors[zone]||"#ffffff"} onChange={v => setTrim(t=>({...t,colors:{...t.colors,[zone]:v}}))} label={label} /></div>
                            </div>
                          );
                        })}
                        <div style={{ height:1, background:"rgba(255,255,255,0.06)", marginBottom:14, marginTop:4 }} />
                      </>
                    )}
                    <SectionLabel>Opacity</SectionLabel>
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
                      <input type="range" min="10" max="100" value={Math.round(trim.opacity*100)} onChange={e => setTrim(t=>({...t,opacity:parseInt(e.target.value)/100}))} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:28, textAlign:"right" }}>{Math.round(trim.opacity*100)}%</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === "pattern" && (
              <div className="fade">

                {/* ── BODY PATTERN IMAGE ── */}
                <SectionLabel>Body Pattern Image</SectionLabel>
                <input type="file" ref={patternFileRef} accept="image/*,.svg" onChange={e => {
                  const file = e.target.files[0]; if (!file) return;
                  const reader = new FileReader();
                  reader.onload = ev => {
                    const img = new Image();
                    img.onload = () => setPatternImage(img);
                    img.src = ev.target.result;
                  };
                  reader.readAsDataURL(file);
                  e.target.value = "";
                }} style={{ display:"none" }} />
                {!patternImage ? (
                  <button onClick={() => patternFileRef.current?.click()} style={{ width:"100%", background:"rgba(239,255,0,0.07)", border:"1px dashed rgba(239,255,0,0.3)", borderRadius:8, padding:"13px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:5, marginBottom:14 }}>
                    <span style={{ fontSize:20, color:"#efff00", lineHeight:1 }}>+</span>
                    <span style={{ fontSize:11, fontWeight:700, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em" }}>UPLOAD PATTERN</span>
                    <span style={{ fontSize:10, color:"#6b7280" }}>PNG, JPG · covers body &amp; panels</span>
                  </button>
                ) : (
                  <div className="fade">
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                      <span style={{ fontSize:11, fontWeight:600, color:"#e2e8f0" }}>Pattern Active</span>
                      <div style={{ display:"flex", gap:6 }}>
                        <button onClick={() => { setPatternImage(null); setPatternTransform({scaleX:1,scaleY:1,offsetX:0,offsetY:0}); }} style={{ background:"rgba(239,68,68,0.15)", border:"1px solid rgba(239,68,68,0.35)", borderRadius:4, color:"#ef4444", cursor:"pointer", fontSize:11, fontWeight:700, padding:"2px 8px", fontFamily:"'Barlow Condensed',sans-serif" }}>✕ REMOVE</button>
                      </div>
                    </div>

                    {/* Opacity */}
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:"#9ca3af", minWidth:52 }}>Opacity</span>
                      <input type="range" min="5" max="100" value={Math.round(patternOpacity*100)} onChange={e => setPatternOpacity(parseInt(e.target.value)/100)} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:32, textAlign:"right" }}>{Math.round(patternOpacity*100)}%</span>
                    </div>

                    {/* Scale */}
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:"#9ca3af", minWidth:52 }}>Scale X</span>
                      <input type="range" min="20" max="300" value={Math.round(patternTransform.scaleX*100)} onChange={e => setPatternTransform(t=>({...t,scaleX:parseInt(e.target.value)/100}))} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:32, textAlign:"right" }}>{Math.round(patternTransform.scaleX*100)}%</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:"#9ca3af", minWidth:52 }}>Scale Y</span>
                      <input type="range" min="20" max="300" value={Math.round(patternTransform.scaleY*100)} onChange={e => setPatternTransform(t=>({...t,scaleY:parseInt(e.target.value)/100}))} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:32, textAlign:"right" }}>{Math.round(patternTransform.scaleY*100)}%</span>
                    </div>

                    {/* Position */}
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:"#9ca3af", minWidth:52 }}>Move X</span>
                      <input type="range" min="-100" max="100" value={Math.round(patternTransform.offsetX*100)} onChange={e => setPatternTransform(t=>({...t,offsetX:parseInt(e.target.value)/100}))} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:32, textAlign:"right" }}>{Math.round(patternTransform.offsetX*100)}</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
                      <span style={{ fontSize:10, color:"#9ca3af", minWidth:52 }}>Move Y</span>
                      <input type="range" min="-100" max="100" value={Math.round(patternTransform.offsetY*100)} onChange={e => setPatternTransform(t=>({...t,offsetY:parseInt(e.target.value)/100}))} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:32, textAlign:"right" }}>{Math.round(patternTransform.offsetY*100)}</span>
                    </div>

                    {/* Rotation */}
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
                      <span style={{ fontSize:10, color:"#9ca3af", minWidth:52 }}>Rotate</span>
                      <input type="range" min="-180" max="180" value={patternTransform.rotation||0} onChange={e => setPatternTransform(t=>({...t,rotation:parseInt(e.target.value)}))} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:32, textAlign:"right" }}>{patternTransform.rotation||0}°</span>
                    </div>

                    {/* Center + Reset */}
                    <div style={{ display:"flex", gap:6, marginBottom:14 }}>
                      <button onClick={() => setPatternTransform(t=>({...t,offsetX:0}))} style={{ flex:1, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:5, padding:"6px 4px", cursor:"pointer", fontSize:9, fontWeight:700, color:"#9ca3af", fontFamily:"'Barlow Condensed',sans-serif" }}>⟺ CENTER H</button>
                      <button onClick={() => setPatternTransform(t=>({...t,offsetY:0}))} style={{ flex:1, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:5, padding:"6px 4px", cursor:"pointer", fontSize:9, fontWeight:700, color:"#9ca3af", fontFamily:"'Barlow Condensed',sans-serif" }}><span style={{ display:"inline-block", transform:"rotate(90deg)" }}>⟺</span> CENTER V</button>
                      <button onClick={() => setPatternTransform({scaleX:1,scaleY:1,offsetX:0,offsetY:0,rotation:0})} style={{ flex:1, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:5, padding:"6px 4px", cursor:"pointer", fontSize:9, fontWeight:700, color:"#9ca3af", fontFamily:"'Barlow Condensed',sans-serif" }}>↺ RESET</button>
                    </div>
                  </div>
                )}

                <div style={{ height:1, background:"rgba(255,255,255,0.06)", marginBottom:14 }} />

                {/* ── PINSTRIPES ── */}
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
                  <SectionLabel>Pinstripes</SectionLabel>
                  <button onClick={() => setStripes(s=>({...s,enabled:!s.enabled}))} style={{ background:stripes.enabled?"rgba(239,255,0,0.15)":"rgba(255,255,255,0.06)", border:stripes.enabled?"1px solid rgba(239,255,0,0.5)":"1px solid rgba(255,255,255,0.12)", borderRadius:20, padding:"3px 12px", cursor:"pointer", fontSize:10, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:stripes.enabled?"#efff00":"#6b7280", letterSpacing:"0.06em" }}>{stripes.enabled?"ON":"OFF"}</button>
                </div>
                {stripes.enabled && (
                  <div className="fade">
                    <div style={{ display:"flex", gap:6, marginBottom:14 }}>
                      {PINSTRIPE_PATTERNS.map(p => (
                        <button key={p.id} className="hov" onClick={() => setStripes(s=>({...s,pattern:p.id}))} style={{ flex:1, background:stripes.pattern===p.id?"rgba(239,255,0,0.1)":"rgba(255,255,255,0.04)", border:stripes.pattern===p.id?"1px solid rgba(239,255,0,0.4)":"1px solid rgba(255,255,255,0.08)", borderRadius:6, padding:"8px 4px", cursor:"pointer", fontSize:10, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:stripes.pattern===p.id?"#efff00":"#9ca3af" }}>{p.label.toUpperCase()}</button>
                      ))}
                    </div>
                    <ColorSwatch color={stripes.color} onChange={v => setStripes(s=>({...s,color:v}))} label="Stripe Color" />
                    <div style={{ height:1, background:"rgba(255,255,255,0.06)", marginBottom:14, marginTop:4 }} />
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:"#9ca3af", minWidth:52 }}>Spacing</span>
                      <input type="range" min="2" max="60" value={stripes.spacing} onChange={e => setStripes(s=>({...s,spacing:parseInt(e.target.value)}))} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:24, textAlign:"right" }}>{stripes.spacing}</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:"#9ca3af", minWidth:52 }}>Width</span>
                      <input type="range" min="1" max="12" value={stripes.width} onChange={e => setStripes(s=>({...s,width:parseInt(e.target.value)}))} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:28, textAlign:"right" }}>{stripes.width}px</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
                      <span style={{ fontSize:10, color:"#9ca3af", minWidth:52 }}>Opacity</span>
                      <input type="range" min="5" max="100" value={Math.round(stripes.opacity*100)} onChange={e => setStripes(s=>({...s,opacity:parseInt(e.target.value)/100}))} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", minWidth:28, textAlign:"right" }}>{Math.round(stripes.opacity*100)}%</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === "logos" && (
              <div className="fade">
                <SectionLabel>Logo Slot</SectionLabel>
                <div style={{ display:"flex", flexDirection:"column", gap:5, marginBottom:14 }}>
                  {LOGO_ZONES.map(z => (
                    <button key={z.id} className="hov" onClick={() => setActiveZone(z.id)} style={{ background:activeZone===z.id?"rgba(239,255,0,0.1)":"rgba(255,255,255,0.04)", border:activeZone===z.id?"1px solid rgba(239,255,0,0.4)":"1px solid rgba(255,255,255,0.08)", borderRadius:6, padding:"9px 12px", cursor:"pointer", fontSize:10, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.04em", color:activeZone===z.id?"#efff00":"#9ca3af", textAlign:"left", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <span>{z.label.toUpperCase()}</span>
                      {activeZone===z.id && <span style={{ fontSize:8, color:"#efff00", opacity:0.7 }}>ACTIVE SLOT</span>}
                    </button>
                  ))}
                </div>
                <input type="file" ref={fileRef} accept="image/*" onChange={handleLogoUpload} style={{ display:"none" }} />
                <button onClick={() => fileRef.current?.click()} style={{ width:"100%", background:"rgba(239,255,0,0.07)", border:"1px dashed rgba(239,255,0,0.3)", borderRadius:8, padding:"13px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:5, marginBottom:14 }}>
                  <span style={{ fontSize:20, color:"#efff00", lineHeight:1 }}>+</span>
                  <span style={{ fontSize:11, fontWeight:700, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em" }}>UPLOAD LOGO</span>
                  <span style={{ fontSize:10, color:"#6b7280" }}>PNG with transparent background</span>
                </button>
                {logos.length > 0 && (
                  <>
                    <SectionLabel>Placed Logos</SectionLabel>
                    {logos.map((logo,idx) => (
                      <div key={logo.id} onClick={() => setSelectedLogoIdx(idx===selectedLogoIdx?null:idx)} style={{ background:selectedLogoIdx===idx?"rgba(239,255,0,0.06)":"rgba(255,255,255,0.03)", border:selectedLogoIdx===idx?"1px solid rgba(239,255,0,0.25)":"1px solid rgba(255,255,255,0.07)", borderRadius:7, padding:"9px 11px", marginBottom:7, cursor:"pointer" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:selectedLogoIdx===idx?10:0 }}>
                          <span style={{ fontSize:11, fontWeight:600, color:"#e2e8f0" }}>{LOGO_ZONES.find(z=>z.id===logo.zone)?.label||"Logo"} {idx+1}</span>
                          <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                            {selectedLogoIdx===idx && (
                              <button onClick={e=>{e.stopPropagation();removeLogo(idx);}} style={{ background:"rgba(239,68,68,0.15)", border:"1px solid rgba(239,68,68,0.35)", borderRadius:4, color:"#ef4444", cursor:"pointer", fontSize:11, fontWeight:700, padding:"2px 8px", fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.05em" }}>✕ REMOVE</button>
                            )}
                            <button onClick={e=>{e.stopPropagation();setSelectedLogoIdx(idx===selectedLogoIdx?null:idx);}} style={{ background:"none", border:"none", color:"#6b7280", cursor:"pointer", fontSize:13, padding:"0 2px" }}>{selectedLogoIdx===idx?"▲":"▼"}</button>
                          </div>
                        </div>
                        {selectedLogoIdx===idx && (
                          <div>
                            <div style={{ marginBottom:9 }}>
                              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}><span style={{ fontSize:10, color:"#9ca3af" }}>Size</span><span style={{ fontSize:10, color:"#9ca3af" }}>{Math.round(logo.size*100)}%</span></div>
                              <input type="range" min="5" max="80" value={Math.round(logo.size*100)} onChange={e => updateLogo(idx,{size:parseInt(e.target.value)/100})} />
                            </div>
                            <div style={{ marginBottom:9 }}>
                              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}><span style={{ fontSize:10, color:"#9ca3af" }}>Opacity</span><span style={{ fontSize:10, color:"#9ca3af" }}>{Math.round(logo.opacity*100)}%</span></div>
                              <input type="range" min="20" max="100" value={Math.round(logo.opacity*100)} onChange={e => updateLogo(idx,{opacity:parseInt(e.target.value)/100})} />
                            </div>
                            <div style={{ marginBottom:9 }}>
                              <span style={{ fontSize:10, color:"#9ca3af", display:"block", marginBottom:5 }}>Center</span>
                              <div style={{ display:"flex", gap:5 }}>
                                <button onClick={() => updateLogo(idx,{rx:0.499})} style={{ flex:1, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:5, padding:"6px 4px", cursor:"pointer", fontSize:9, fontWeight:700, color:"#9ca3af", fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.04em" }}>⟺ HORIZONTAL</button>
                                <button onClick={() => updateLogo(idx,{ry:0.499})} style={{ flex:1, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:5, padding:"6px 4px", cursor:"pointer", fontSize:9, fontWeight:700, color:"#9ca3af", fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.04em" }}><span style={{ display:"inline-block", transform:"rotate(90deg)" }}>⟺</span> VERTICAL</button>
                              </div>
                            </div>

                          </div>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* CENTER */}
        <div
          ref={centerRef}
          style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"#1f1c1e", position:"relative", overflow:"hidden", cursor: panningActive ? "grabbing" : spaceActive ? "grab" : "default" }}
          onWheel={handleWheel}
          onMouseDown={handlePanStart}
          onMouseMove={handlePanMove}
          onMouseUp={handlePanEnd}
          onMouseLeave={handlePanEnd}
        >
          {/* Grid overlay */}
          <div style={{ position:"absolute", inset:0, opacity:0.03, backgroundImage:"linear-gradient(rgba(255,255,255,0.4) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.4) 1px,transparent 1px)", backgroundSize:"36px 36px", pointerEvents:"none" }} />

          {/* Zoom + pan wrapper — jersey is centered here */}
          <div style={{ transform:`translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin:"center center", transition: panningActive ? "none" : "transform 0.08s ease", willChange:"transform", position:"relative" }}>

            {/* Background image — sits behind jersey canvas, same 1000x1000 footprint */}
            {bg.enabled && (
              <div style={{ position:"absolute", inset:0, zIndex:0, borderRadius:4, overflow:"hidden" }}>
                <img src="/background.png" alt="" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
                {/* Color tint mask — only applied if color is not white/default */}
                {bg.color !== "#ffffff" && (
                  <div style={{ position:"absolute", inset:0, background:bg.color, mixBlendMode:"multiply", opacity:1 }} />
                )}
              </div>
            )}

            {/* Jersey canvas — on top of background */}
            <div style={{ position:"relative", zIndex:1, width:"min(680px,60vw,58vh)", filter:"drop-shadow(0 20px 60px rgba(0,0,0,0.85))" }}>
              <JerseyCanvas colors={colors} stripePattern={stripePattern} stripeColors={stripeColors} logos={logos} activeZone={activeTab==="logos"?activeZone:null} selectedLogoIdx={selectedLogoIdx} onZoneClick={id=>{setActiveZone(id);setActiveTab("logos");}} onLogoMove={handleLogoMove} onDeselect={() => setSelectedLogoIdx(null)} onRemoveLogo={removeLogo} onSelectLogo={setSelectedLogoIdx} jerseyImage={jerseyImage} svgData={svgData} brightness={brightness} stripes={stripes} trim={trim} trimSvgData={trimSvgData} patternImage={patternImage} patternOpacity={patternOpacity} patternTransform={patternTransform} />
            </div>
          </div>

          {/* Zoom controls */}
          <div style={{ position:"absolute", bottom:16, right:16, display:"flex", alignItems:"center", gap:6, background:"rgba(0,0,0,0.5)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, padding:"5px 8px" }}>
            <button onClick={() => setZoom(z => Math.min(4, Math.round((z+0.25)*4)/4))} style={{ background:"none", border:"none", color:"#e2e8f0", cursor:"pointer", fontSize:16, lineHeight:1, padding:"2px 4px", fontWeight:700 }}>+</button>
            <span style={{ fontSize:11, color:"#9ca3af", fontFamily:"'Barlow Condensed',sans-serif", minWidth:32, textAlign:"center", fontWeight:700 }}>{Math.round(zoom*100)}%</span>
            <button onClick={() => setZoom(z => Math.max(0.5, Math.round((z-0.25)*4)/4))} style={{ background:"none", border:"none", color:"#e2e8f0", cursor:"pointer", fontSize:16, lineHeight:1, padding:"2px 4px", fontWeight:700 }}>−</button>
            <div style={{ width:1, height:14, background:"rgba(255,255,255,0.15)", margin:"0 2px" }} />
            <button onClick={resetView} style={{ background:"none", border:"none", color:"#9ca3af", cursor:"pointer", fontSize:9, lineHeight:1, padding:"2px 4px", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, letterSpacing:"0.06em" }}>RESET</button>
          </div>

          <div style={{ position:"absolute", bottom:16, left:"50%", transform:"translateX(-50%)", fontSize:10, color:"#374151", letterSpacing:"0.1em", fontFamily:"'Barlow Condensed',sans-serif", pointerEvents:"none", whiteSpace:"nowrap" }}>
            SCROLL TO ZOOM · SPACE+DRAG TO PAN · {collar.label.toUpperCase()} COLLAR
          </div>
        </div>

        {/* RIGHT */}
        <div style={{ background:"#161314", borderLeft:"1px solid rgba(255,255,255,0.07)", display:"flex", flexDirection:"column", overflow:"hidden", visibility:hideControls?"hidden":"visible" }}>
          <div style={{ padding:"12px 14px", borderBottom:"1px solid rgba(255,255,255,0.07)", flexShrink:0 }}>
            <SectionLabel>Current Colors</SectionLabel>
            <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
              {Object.entries(colors).filter(([k]) => k !== "triangle" || collar.id === "v-neck-triangle").map(([key,val]) => (
                <div key={key} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:3 }}>
                  <div style={{ width:24, height:24, borderRadius:5, background:val, border:"1px solid rgba(255,255,255,0.12)" }} />
                  <span style={{ fontSize:8, color:"#6b7280", fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.04em", textTransform:"uppercase" }}>{key}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ padding:"10px 14px", borderBottom:"1px solid rgba(255,255,255,0.07)", flexShrink:0 }}>
            <SectionLabel>Active Collar</SectionLabel>
            <div style={{ background:"rgba(239,255,0,0.07)", border:"1px solid rgba(239,255,0,0.2)", borderRadius:7, padding:"9px 12px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:13, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:"#efff00", letterSpacing:"0.05em" }}>{collar.label.toUpperCase()}</span>
              <button onClick={() => setActiveTab("collar")} style={{ background:"none", border:"1px solid rgba(239,255,0,0.25)", borderRadius:4, padding:"3px 8px", cursor:"pointer", fontSize:9, fontWeight:700, color:"#efff00", fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em" }}>CHANGE</button>
            </div>
          </div>

          <div style={{ padding:"14px 16px", overflowY:"auto", flex:1, minHeight:0 }}>
            <SectionLabel>Tips</SectionLabel>
            {[
              {icon:"◈", text:"Click any swatch or type a hex code to change colors"},
              {icon:"◎", text:"PNGs with no background work best for logos"},
              {icon:"◉", text:"Don't use pure white (#FFFFFF) or pure black (#000000) — you'll lose detail"},
              {icon:"∞", text:"You can add multiple logos to each zone — no limits"},
              {icon:"★", text:"Exports include watermark — upgrade to remove it"},
            ].map((tip,i) => (
              <div key={i} style={{ display:"flex", gap:9, marginBottom:10, alignItems:"flex-start" }}>
                <span style={{ color:"#efff00", fontSize:12, lineHeight:1.5, flexShrink:0 }}>{tip.icon}</span>
                <span style={{ fontSize:11, color:"#4b5563", lineHeight:1.5 }}>{tip.text}</span>
              </div>
            ))}
          </div>

          <div style={{ padding:"12px 14px", borderTop:"1px solid rgba(255,255,255,0.07)", flexShrink:0 }}>
            <div style={{ background:"rgba(239,255,0,0.05)", border:"1px solid rgba(239,255,0,0.14)", borderRadius:9, padding:"10px 12px", marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                <span style={{ fontSize:11, color:"#9ca3af" }}>Credits remaining</span>
                <span style={{ fontSize:20, fontWeight:900, color:credits>0?"#efff00":"#ef4444", fontFamily:"'Barlow Condensed',sans-serif" }}>{isUnlimited ? "∞" : credits}</span>
              </div>
              <div style={{ height:3, background:"rgba(255,255,255,0.06)", borderRadius:2 }}>
                <div style={{ height:"100%", width:isUnlimited ? "100%" : `${Math.min(100,(credits/CREDITS_INITIAL)*100)}%`, background:isUnlimited?"#10b981":"#efff00", borderRadius:2, transition:"width 0.4s ease" }} />
              </div>
              <div style={{ fontSize:9, color:"#6b7280", marginTop:4 }}>{isUnlimited ? "Unlimited watermark-free exports" : "FREE EXPORTS INCLUDE PROLINE WATERMARK"}</div>
            </div>
            <button onClick={handleExport} disabled={exporting} style={{ width:"100%", background:credits>0?(exporting?"rgba(239,255,0,0.45)":"linear-gradient(135deg,#efff00,#c8d900)"):"rgba(239,68,68,0.12)", border:credits>0?"none":"1px solid rgba(239,68,68,0.3)", borderRadius:8, padding:"13px", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:14, letterSpacing:"0.08em", color:credits>0?"#000":"#ef4444", cursor:"pointer", animation:exporting?"pulse 0.9s infinite":"none" }}>
              {exported?"✓ DOWNLOADED!":exporting?"EXPORTING...":credits>0?"↓ EXPORT PNG":"NO CREDITS — UPGRADE"}
            </button>
            {credits<=1&&credits>0&&(
              <button onClick={handleGetCredits} style={{ width:"100%", marginTop:7, background:"none", border:"1px solid rgba(255,255,255,0.09)", borderRadius:8, padding:"9px", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:11, color:"#6b7280", cursor:"pointer", letterSpacing:"0.05em" }}>UPGRADE → REMOVE WATERMARK</button>
            )}
          </div>
        </div>
      </div>

      {/* UPGRADE MODAL */}
      {showUpgrade && (
        <div onClick={()=>setShowUpgrade(false)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.78)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 }}>
          <div onClick={e=>e.stopPropagation()} style={{ background:"#161314", borderRadius:16, border:"1px solid rgba(255,255,255,0.1)", padding:"30px", width:460, maxWidth:"90vw", animation:"fadeIn 0.2s ease" }}>
            <div style={{ textAlign:"center", marginBottom:20 }}>
              <div style={{ fontSize:26, marginBottom:8 }}>⚡</div>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:24, letterSpacing:"0.05em", marginBottom:6 }}>UPGRADE YOUR PLAN</div>
              <div style={{ fontSize:12, color:"#9ca3af", lineHeight:1.6 }}>Remove the ProLine watermark and get more exports.</div>
            </div>

            {/* Subscription option */}
            <button onClick={() => setSelectedPlan("NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED")} style={{ width:"100%", background:selectedPlan==="NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED"?"rgba(239,255,0,0.15)":"rgba(239,255,0,0.06)", border:selectedPlan==="NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED"?"2px solid rgba(239,255,0,0.7)":"2px solid rgba(239,255,0,0.35)", borderRadius:10, padding:"14px 16px", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16, position:"relative" }}>
              <div style={{ position:"absolute", top:-10, left:16, background:"#efff00", color:"#000", fontSize:8, fontWeight:800, padding:"2px 8px", borderRadius:3, fontFamily:"'Barlow Condensed',sans-serif", whiteSpace:"nowrap" }}>MOST POPULAR</div>
              <div style={{ textAlign:"left" }}>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:16, color:"#efff00", letterSpacing:"0.04em" }}>UNLIMITED MONTHLY</div>
                <div style={{ fontSize:10, color:"#9ca3af", marginTop:2 }}>Unlimited watermark-free exports · cancel anytime</div>
              </div>
              <div style={{ textAlign:"right", flexShrink:0, marginLeft:12 }}>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:22, color:"#fff" }}>$4.99</div>
                <div style={{ fontSize:9, color:"#6b7280" }}>per month</div>
              </div>
            </button>

            {/* Divider */}
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
              <div style={{ flex:1, height:1, background:"rgba(255,255,255,0.07)" }} />
              <span style={{ fontSize:10, color:"#4b5563", fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.08em" }}>OR BUY CREDITS</span>
              <div style={{ flex:1, height:1, background:"rgba(255,255,255,0.07)" }} />
            </div>

            {/* Credit packs */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:9, marginBottom:10 }}>
              {[{credits:5,price:"$4.99",per:"$1.00 ea",priceKey:"NEXT_PUBLIC_STRIPE_PRICE_5_CREDITS"},{credits:15,price:"$9.99",per:"$0.67 ea",priceKey:"NEXT_PUBLIC_STRIPE_PRICE_15_CREDITS"},{credits:50,price:"$24.99",per:"$0.50 ea",priceKey:"NEXT_PUBLIC_STRIPE_PRICE_50_CREDITS"}].map(plan => (
                <button key={plan.credits} onClick={() => setSelectedPlan(plan.priceKey)} style={{ background:selectedPlan===plan.priceKey?"rgba(239,255,0,0.1)":"rgba(255,255,255,0.04)", border:selectedPlan===plan.priceKey?"1px solid rgba(239,255,0,0.5)":"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"13px 6px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:3, position:"relative" }}>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:28, color:"#e2e8f0" }}>{plan.credits}</div>
                  <div style={{ fontSize:9, color:"#9ca3af" }}>credits</div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:17, color:"#fff", marginTop:3 }}>{plan.price}</div>
                  <div style={{ fontSize:9, color:"#6b7280" }}>{plan.per}</div>
                </button>
              ))}
            </div>
            <div style={{ fontSize:10, color:"#10b981", textAlign:"center", marginBottom:16, display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
              <span>✓</span> Purchased credits are always watermark-free · free credits include watermark
            </div>

            <button onClick={async () => {
              if (!selectedPlan) return;
              const PRICE_IDS = {
                "NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED":  process.env.NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED,
                "NEXT_PUBLIC_STRIPE_PRICE_5_CREDITS":  process.env.NEXT_PUBLIC_STRIPE_PRICE_5_CREDITS,
                "NEXT_PUBLIC_STRIPE_PRICE_15_CREDITS": process.env.NEXT_PUBLIC_STRIPE_PRICE_15_CREDITS,
                "NEXT_PUBLIC_STRIPE_PRICE_50_CREDITS": process.env.NEXT_PUBLIC_STRIPE_PRICE_50_CREDITS,
              };
              const priceId = PRICE_IDS[selectedPlan];
              const r = await fetch('/api/stripe/checkout', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({priceId})});
              const d = await r.json();
              if (d.url) window.location.href = d.url;
            }} style={{ width:"100%", background:selectedPlan?"linear-gradient(135deg,#efff00,#c8d900)":"rgba(255,255,255,0.08)", border:"none", borderRadius:8, padding:"13px", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:14, letterSpacing:"0.06em", color:selectedPlan?"#000":"#6b7280", cursor:selectedPlan?"pointer":"default", marginBottom:8, transition:"all 0.15s ease" }}>CONTINUE TO CHECKOUT →</button>
            <button onClick={()=>setShowUpgrade(false)} style={{ width:"100%", background:"none", border:"none", fontSize:11, color:"#6b7280", cursor:"pointer", padding:"7px", fontFamily:"'Barlow Condensed',sans-serif" }}>Maybe later</button>
            <div style={{ textAlign:"center", marginTop:10, fontSize:11, color:"#4b5563", lineHeight:1.6 }}>
              Not into credits? Want more control? Purchase the Photoshop template{" "}
              <a href="https://www.prolinemockups.com/templates/p/proline-basketball-jersey-hanger" target="_blank" rel="noopener noreferrer" style={{ color:"#efff00", textDecoration:"underline", cursor:"pointer" }}>here</a>.
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
