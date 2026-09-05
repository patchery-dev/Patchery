/* ============================================================================
   Patchery — docs/assets/hero.js
   The hero background: a dependency graph that keeps breaking and getting
   repaired. A node goes red, the failure propagates along its edges, and a
   teal wave walks back out from the same origin and clears it.

   Three.js r128 (UMD global). If it is unavailable, or the machine asks for
   reduced motion, nothing here runs and the hero falls back to flat CSS.
   ========================================================================== */
(function () {
  "use strict";

  var canvas = document.getElementById("graph");
  if (!canvas) return;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !window.THREE) return;

  var gl = null;
  try {
    gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
  } catch (e) { /* ignore */ }
  if (!gl) return;

  var THREE = window.THREE;

  /* ── graph ───────────────────────────────────────────────────────────── */

  var narrow = window.innerWidth < 900;
  var COUNT = narrow ? 74 : 132;
  var RADIUS = 92;

  var pos = new Float32Array(COUNT * 3);
  var drift = new Float32Array(COUNT * 3);   // per-node idle wander
  var phase = new Float32Array(COUNT);
  var size = new Float32Array(COUNT);
  var col = new Float32Array(COUNT * 3);

  var heat = new Float32Array(COUNT);        // 0..1  broken (red)
  var heatT = new Float32Array(COUNT);
  var glow = new Float32Array(COUNT);        // 0..1  repaired (teal flash)
  var glowT = new Float32Array(COUNT);

  var i, j, k;

  // Node 0 is the project itself; the rest sit in a flattened shell around it,
  // denser near the middle so the graph reads as one thing rather than a cloud.
  for (i = 0; i < COUNT; i++) {
    if (i === 0) {
      pos[0] = 0; pos[1] = 0; pos[2] = 0;
      size[0] = 5.6;
    } else {
      var t = Math.acos(2 * Math.random() - 1);
      var p = Math.random() * Math.PI * 2;
      var r = RADIUS * (0.28 + 0.72 * Math.pow(Math.random(), 0.62));
      pos[i * 3]     = r * Math.sin(t) * Math.cos(p) * 1.28;
      pos[i * 3 + 1] = r * Math.cos(t) * 0.66;
      pos[i * 3 + 2] = r * Math.sin(t) * Math.sin(p) * 0.92;
      size[i] = 1.5 + Math.random() * 2.4;
    }
    drift[i * 3]     = (Math.random() - 0.5) * 2.2;
    drift[i * 3 + 1] = (Math.random() - 0.5) * 2.2;
    drift[i * 3 + 2] = (Math.random() - 0.5) * 2.2;
    phase[i] = Math.random() * Math.PI * 2;
  }

  var basePos = pos.slice();

  // Edges: nearest neighbours, plus a spoke from the project to the closest ring.
  var edges = [];
  var adj = [];
  for (i = 0; i < COUNT; i++) adj.push([]);

  function link(a, b) {
    if (a === b) return;
    for (var n = 0; n < adj[a].length; n++) if (adj[a][n] === b) return;
    edges.push(a, b);
    adj[a].push(b);
    adj[b].push(a);
  }

  var d2 = function (a, b) {
    var dx = basePos[a * 3] - basePos[b * 3];
    var dy = basePos[a * 3 + 1] - basePos[b * 3 + 1];
    var dz = basePos[a * 3 + 2] - basePos[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };

  for (i = 1; i < COUNT; i++) {
    var best = [-1, -1], bestD = [Infinity, Infinity];
    for (j = 1; j < COUNT; j++) {
      if (i === j) continue;
      var dd = d2(i, j);
      if (dd < bestD[0]) { bestD[1] = bestD[0]; best[1] = best[0]; bestD[0] = dd; best[0] = j; }
      else if (dd < bestD[1]) { bestD[1] = dd; best[1] = j; }
    }
    if (best[0] > -1) link(i, best[0]);
    if (best[1] > -1 && Math.random() < 0.55) link(i, best[1]);
    if (d2(i, 0) < RADIUS * RADIUS * 0.36) link(0, i);
  }

  var EDGE_COUNT = edges.length / 2;

  /* ── geometry ────────────────────────────────────────────────────────── */

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(50, 1, 1, 900);
  camera.position.set(0, 0, 215);

  var group = new THREE.Group();
  group.position.x = narrow ? 0 : 36;
  scene.add(group);

  var nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  nodeGeo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  nodeGeo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));

  var nodeMat = new THREE.ShaderMaterial({
    uniforms: { uPix: { value: 1 } },
    vertexShader: [
      "attribute float aSize;",
      "attribute vec3 aColor;",
      "uniform float uPix;",
      "varying vec3 vColor;",
      "varying float vFade;",
      "void main() {",
      "  vColor = aColor;",
      "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
      "  gl_Position = projectionMatrix * mv;",
      "  float dist = max(-mv.z, 1.0);",
      "  gl_PointSize = aSize * (340.0 / dist) * uPix;",
      "  vFade = clamp(1.0 - (dist - 130.0) / 250.0, 0.14, 1.0);",
      "}"
    ].join("\n"),
    fragmentShader: [
      "varying vec3 vColor;",
      "varying float vFade;",
      "void main() {",
      "  vec2 c = gl_PointCoord - 0.5;",
      "  float r = length(c);",
      "  if (r > 0.5) discard;",
      "  float core = smoothstep(0.5, 0.0, r);",
      "  float halo = pow(core, 3.2);",
      "  gl_FragColor = vec4(vColor * (0.30 + halo * 2.0), (halo * 0.92 + core * 0.10) * vFade);",
      "}"
    ].join("\n"),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  var nodes = new THREE.Points(nodeGeo, nodeMat);
  group.add(nodes);

  var edgePos = new Float32Array(EDGE_COUNT * 6);
  var edgeCol = new Float32Array(EDGE_COUNT * 6);
  var edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
  edgeGeo.setAttribute("color", new THREE.BufferAttribute(edgeCol, 3));

  var lines = new THREE.LineSegments(
    edgeGeo,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  group.add(lines);

  /* ── the break / repair cycle ────────────────────────────────────────── */

  var IDLE = [0.075, 0.125, 0.150];   // slate, barely there
  var TEAL = [0.000, 0.769, 0.549];   // #00c48c
  var RED  = [0.949, 0.333, 0.353];   // #f2555a

  var queue = [];
  var nextCycle = 1200;

  function levelsFrom(origin, maxDepth) {
    var depth = new Int8Array(COUNT).fill(-1);
    depth[origin] = 0;
    var frontier = [origin], order = [[origin, 0]];
    while (frontier.length) {
      var next = [];
      for (var a = 0; a < frontier.length; a++) {
        var node = frontier[a], nb = adj[node];
        for (var b = 0; b < nb.length; b++) {
          var m = nb[b];
          if (depth[m] !== -1) continue;
          depth[m] = depth[node] + 1;
          if (depth[m] > maxDepth) continue;
          order.push([m, depth[m]]);
          next.push(m);
        }
      }
      frontier = next;
    }
    return order;
  }

  function scheduleCycle(now) {
    var origin = 1 + Math.floor(Math.random() * (COUNT - 1));
    var wave = levelsFrom(origin, 3);
    var spread = 0;

    // the break spreads outward
    for (var a = 0; a < wave.length; a++) {
      var idx = wave[a][0], lvl = wave[a][1];
      var at = now + lvl * 210 + Math.random() * 90;
      spread = Math.max(spread, at - now);
      queue.push({ at: at, i: idx, heat: lvl === 0 ? 1 : Math.max(0.25, 1 - lvl * 0.26), glow: 0 });
    }

    // then the repair walks back out from the same origin
    var repairAt = now + spread + 1500;
    for (var b = 0; b < wave.length; b++) {
      var idx2 = wave[b][0], lvl2 = wave[b][1];
      queue.push({ at: repairAt + lvl2 * 190, i: idx2, heat: 0, glow: 1 });
      queue.push({ at: repairAt + lvl2 * 190 + 700, i: idx2, heat: 0, glow: 0 });
    }

    nextCycle = repairAt + spread + 3400;
  }

  /* ── loop ────────────────────────────────────────────────────────────── */

  var renderer = new THREE.WebGLRenderer({
    canvas: canvas, alpha: true, antialias: true, powerPreference: "high-performance"
  });
  renderer.setClearColor(0x000000, 0);

  var W = 0, H = 0, pix = 1;

  function resize() {
    var host = canvas.parentElement;
    W = host.clientWidth;
    H = host.clientHeight;
    pix = Math.min(window.devicePixelRatio || 1, 1.85);
    renderer.setPixelRatio(pix);
    renderer.setSize(W, H, false);
    camera.aspect = W / Math.max(H, 1);
    camera.updateProjectionMatrix();
    nodeMat.uniforms.uPix.value = pix;
    narrow = window.innerWidth < 900;
    group.position.x = narrow ? 0 : 36;
  }
  resize();
  window.addEventListener("resize", resize, { passive: true });

  var mx = 0, my = 0, tx = 0, ty = 0;
  window.addEventListener("pointermove", function (e) {
    tx = (e.clientX / window.innerWidth - 0.5) * 2;
    ty = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  var visible = true;
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
    }, { threshold: 0 }).observe(canvas.parentElement);
  }

  var start = performance.now();
  var revealed = false;

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || W === 0) return;

    var t = (now - start) * 0.001;
    var elapsed = now - start;

    if (elapsed > nextCycle) scheduleCycle(elapsed);

    while (queue.length && queue[0].at <= elapsed) {
      var ev = queue.shift();
      heatT[ev.i] = ev.heat;
      glowT[ev.i] = ev.glow;
    }
    // events are pushed out of order, so keep the head of the queue honest
    if (queue.length > 1) queue.sort(function (a, b) { return a.at - b.at; });

    mx += (tx - mx) * 0.045;
    my += (ty - my) * 0.045;

    group.rotation.y = t * 0.045 + mx * 0.24;
    group.rotation.x = -my * 0.16 + Math.sin(t * 0.21) * 0.045;

    // node positions + colours
    for (var n = 0; n < COUNT; n++) {
      var o = n * 3;
      var w = t * 0.32 + phase[n];
      pos[o]     = basePos[o]     + Math.sin(w) * drift[o];
      pos[o + 1] = basePos[o + 1] + Math.cos(w * 0.88) * drift[o + 1];
      pos[o + 2] = basePos[o + 2] + Math.sin(w * 1.13) * drift[o + 2];

      heat[n] += (heatT[n] - heat[n]) * (heatT[n] > heat[n] ? 0.16 : 0.055);
      glow[n] += (glowT[n] - glow[n]) * (glowT[n] > glow[n] ? 0.22 : 0.035);

      // idle shimmer so the graph never looks frozen
      var breathe = 0.10 + 0.10 * (0.5 + 0.5 * Math.sin(t * 1.15 + phase[n] * 2.2));
      var g = Math.min(1, glow[n] + (n === 0 ? 0.55 : breathe * 0.55));

      var r0 = IDLE[0] + (TEAL[0] - IDLE[0]) * g;
      var g0 = IDLE[1] + (TEAL[1] - IDLE[1]) * g;
      var b0 = IDLE[2] + (TEAL[2] - IDLE[2]) * g;

      col[o]     = r0 + (RED[0] - r0) * heat[n];
      col[o + 1] = g0 + (RED[1] - g0) * heat[n];
      col[o + 2] = b0 + (RED[2] - b0) * heat[n];
    }

    // edges inherit the dimmer of their two endpoints
    for (var e = 0; e < EDGE_COUNT; e++) {
      var a = edges[e * 2], b = edges[e * 2 + 1];
      var eo = e * 6, ao = a * 3, bo = b * 3;
      edgePos[eo]     = pos[ao];     edgePos[eo + 1] = pos[ao + 1]; edgePos[eo + 2] = pos[ao + 2];
      edgePos[eo + 3] = pos[bo];     edgePos[eo + 4] = pos[bo + 1]; edgePos[eo + 5] = pos[bo + 2];

      var f = 0.30;
      edgeCol[eo]     = col[ao] * f;     edgeCol[eo + 1] = col[ao + 1] * f; edgeCol[eo + 2] = col[ao + 2] * f;
      edgeCol[eo + 3] = col[bo] * f;     edgeCol[eo + 4] = col[bo + 1] * f; edgeCol[eo + 5] = col[bo + 2] * f;
    }

    nodeGeo.attributes.position.needsUpdate = true;
    nodeGeo.attributes.aColor.needsUpdate = true;
    edgeGeo.attributes.position.needsUpdate = true;
    edgeGeo.attributes.color.needsUpdate = true;

    renderer.render(scene, camera);

    if (!revealed) { revealed = true; canvas.classList.add("is-on"); }
  }

  requestAnimationFrame(frame);
})();
