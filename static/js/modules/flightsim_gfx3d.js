// Uçuş Simülatörü §43 — grafik kalitesi SON İŞLEM HATTI (three.js; flightsim3d.js tek paylaşılan WebGLRenderer üzerinde, ikinci bağlam YOK).
// EffectComposer yerel kopyada yok → kendi küçük hattımız (tam ekran üçgen geçişleri, aynı renderer):
//   sahne → sahne hedefi (HalfFloat HDR; MSAA 4×/8× WebGL2 çok örnekli render hedefi; SSAO açıkken derinlik dokusu)
//   [SSAO: yarım/tam çözünürlük, derinlikten görünüm uzayı konum + normal, 8/16 örnek spiral; derinliğe duyarlı bulanıklaştırma]
//   [bloom: parlak geçiş ½ → 3 mip (½, ¼, ⅛) ayrılabilir Gauss]
//   son geçiş → ekran: AO çarpımı + bloom + ACES Filmic ton eşleme + renk derecelendirme (kontrast/doygunluk/sıcaklık) + vinyet + (isteğe bağlı) FXAA + sRGB.
// Son işlem kapalıyken yalnız FXAA ya da tuval-dışı MSAA (8× veya tuval antialias'sız açılmış) için aynı hat ton eşlemesiz kopya yapar;
// hiçbiri gerekmiyorsa doğrudan renderer.render (ek maliyet yok). Tüm hedefler boyut/ayar değişince sahneyi kaybetmeden yeniden kurulur.
// Dışa: createGfxPipeline(T, renderer, { nativeAA }) → { set(params), render(scene, camera), get samples, get active, info(), dispose() }.

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BRIGHT_FRAG = `uniform sampler2D tSrc; uniform vec2 texel; uniform float threshold, knee; varying vec2 vUv;
void main(){
  vec3 c = 0.25 * (texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb
    + texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb);
  float l = max(c.r, max(c.g, c.b));
  float s = clamp(l - threshold + knee, 0.0, 2.0 * knee); s = s * s / (4.0 * knee + 1e-4);
  float w = max(s, l - threshold) / max(l, 1e-4);
  gl_FragColor = vec4(min(c * w, vec3(8.0)), 1.0);
}`;
// 9 vuruşlu Gauss (doğrusal örnekleme ile 5 okuma)
const BLUR_FRAG = `uniform sampler2D tSrc; uniform vec2 dir; varying vec2 vUv;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
  c += texture2D(tSrc, vUv + dir * 1.3846153846).rgb * 0.3162162162; c += texture2D(tSrc, vUv - dir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv + dir * 3.2307692308).rgb * 0.0702702703; c += texture2D(tSrc, vUv - dir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;
// SSAO (SAO benzeri): görünüm uzayı konum derinlikten (projInv), normal komşu konumlardan; ekran uzayında spiral örnekler; 150–400 m arası söner
const AO_FRAG = `#include <packing>
uniform sampler2D tDepth; uniform vec2 texel; uniform mat4 projInv, proj; uniform float radius, intensity, cameraNear, cameraFar; varying vec2 vUv;
vec3 vpos(vec2 uv){ float d = texture2D(tDepth, uv).x; vec4 c = projInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return c.xyz / c.w; }
void main(){
  float d0 = texture2D(tDepth, vUv).x;
  if (d0 >= 0.99999) { gl_FragColor = vec4(1.0); return; }
  vec3 p = vpos(vUv);
  float dist = -p.z;
  if (dist > 400.0) { gl_FragColor = vec4(1.0); return; }
  vec3 px = vpos(vUv + vec2(texel.x, 0.0)), py = vpos(vUv + vec2(0.0, texel.y));
  vec3 n = normalize(cross(px - p, py - p));
  float r = radius * (1.0 + dist * 0.02);
  float rpx = clamp(r * proj[1][1] * 0.5 / max(dist, 0.1), 3.0 * texel.y, 0.08);   // ekran uv yarıçapı
  float ao = 0.0, ang = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
  for (int i = 0; i < AO_N; i++) {
    float t = (float(i) + 0.5) / float(AO_N);
    float a = ang + t * 15.0796;   // 2,4 tur spiral
    vec2 o = vec2(cos(a), sin(a)) * rpx * t;
    o.x *= texel.x / texel.y;
    vec3 v = vpos(vUv + o) - p;
    float vv = dot(v, v), vn = dot(v, n);
    ao += max(0.0, vn - 0.015 * dist) / (vv + 0.01 * r * r) * max(0.0, 1.0 - vv / (r * r));
  }
  ao = clamp(1.0 - intensity * ao * r / float(AO_N) * 2.0, 0.0, 1.0);
  ao = mix(1.0, ao, 1.0 - smoothstep(150.0, 400.0, dist));
  gl_FragColor = vec4(vec3(ao), 1.0);
}`;
const AO_BLUR_FRAG = `uniform sampler2D tAO, tDepth; uniform vec2 texel; uniform float cameraNear, cameraFar; varying vec2 vUv;
#include <packing>
float lz(vec2 uv){ return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
void main(){
  float z0 = lz(vUv), s = 0.0, w = 0.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    vec2 uv = vUv + vec2(float(x), float(y)) * texel;
    float k = 1.0 / (1.0 + abs(lz(uv) - z0) * 4.0 / max(z0 * 0.02, 0.05));
    s += texture2D(tAO, uv).r * k; w += k;
  }
  gl_FragColor = vec4(vec3(s / max(w, 1e-4)), 1.0);
}`;
const FINAL_FRAG = `uniform sampler2D tScene, tB0, tB1, tB2, tAO; uniform vec2 texel; uniform float bloom, aoOn, vignette, grade, exposure, post; varying vec2 vUv;
vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 acesFilmic(vec3 c){
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c *= exposure / 0.6; c = ACESInputMat * c; c = RRTAndODTFit(c); c = ACESOutputMat * c; return clamp(c, 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
vec3 shade(vec2 uv){
  vec3 c = texture2D(tScene, uv).rgb;
  if (post > 0.5) {
    if (aoOn > 0.5) c *= texture2D(tAO, uv).r;
    if (bloom > 0.0) c += bloom * (texture2D(tB0, uv).rgb * 0.5 + texture2D(tB1, uv).rgb * 0.8 + texture2D(tB2, uv).rgb * 1.1);
    // ACES Filmic: parlak tonları yumuşak sıkıştırır; sahne ton eşlemesiz ayarlandığından koyu tonlarda (ağaç, gölge) doğrusal korunur —
    // ACES'in "toe" bölgesi bunları ~2× koyulaştırıp siyaha yakın gösteriyordu. Geçiş parlaklığa göre (0 → 0,55).
    float l0 = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(clamp(c * exposure, 0.0, 1.0), acesFilmic(c), smoothstep(0.0, 0.55, l0));
    if (grade > 0.0) {
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.0 + 0.06 * grade);                       // doygunluk
      c = (c - 0.5) * (1.0 + 0.06 * grade) + 0.5;                     // kontrast
      c *= vec3(1.0 + 0.02 * grade, 1.0, 1.0 - 0.025 * grade);       // hafif sıcak
      c = clamp(c, 0.0, 1.0);
    }
  } else c = clamp(c, 0.0, 1.0);
  return toSRGB(c);
}
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 col;
#ifdef FXAA
  vec3 rgbNW = shade(vUv + vec2(-1.0, -1.0) * texel), rgbNE = shade(vUv + vec2(1.0, -1.0) * texel), rgbSW = shade(vUv + vec2(-1.0, 1.0) * texel), rgbSE = shade(vUv + vec2(1.0, 1.0) * texel), rgbM = shade(vUv);
  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), vec2(-8.0), vec2(8.0)) * texel;
  vec3 A = 0.5 * (shade(vUv + dir * (1.0 / 3.0 - 0.5)) + shade(vUv + dir * (2.0 / 3.0 - 0.5)));
  vec3 B = A * 0.5 + 0.25 * (shade(vUv - dir * 0.5) + shade(vUv + dir * 0.5));
  float lB = luma(B);
  col = (lB < lMin || lB > lMax) ? A : B;
#else
  col = shade(vUv);
#endif
  if (post > 0.5 && vignette > 0.0) { vec2 d = vUv - 0.5; col *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2); }
  gl_FragColor = vec4(col, 1.0);
}`;

export function createGfxPipeline(T, renderer, { nativeAA = true } = {}) {
  const ext = renderer.extensions;
  const halfOK = !!(ext.has?.('EXT_color_buffer_float') || ext.has?.('EXT_color_buffer_half_float'));
  const maxSamples = renderer.capabilities?.maxSamples ?? 4;
  const P = { samples: 0, fxaa: false, post: false, bloom: 0, ao: 0, vignette: 0, grade: 0, exposure: 1 };
  const quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const tri = new T.BufferGeometry();
  tri.setAttribute('position', new T.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  tri.setAttribute('uv', new T.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quad = new T.Mesh(tri); quad.frustumCulled = false;
  const qs = new T.Scene(); qs.add(quad);
  const mat = (frag, uniforms, defines = {}) => new T.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false });
  const brightM = mat(BRIGHT_FRAG, { tSrc: { value: null }, texel: { value: new T.Vector2() }, threshold: { value: 0.92 }, knee: { value: 0.35 } });
  const blurM = mat(BLUR_FRAG, { tSrc: { value: null }, dir: { value: new T.Vector2() } });
  const aoU = { tDepth: { value: null }, texel: { value: new T.Vector2() }, projInv: { value: new T.Matrix4() }, proj: { value: new T.Matrix4() }, radius: { value: 2.2 }, intensity: { value: 1.1 }, cameraNear: { value: 0.5 }, cameraFar: { value: 60000 } };
  let aoM = null, aoN = 0;
  const aoBlurM = mat(AO_BLUR_FRAG, { tAO: { value: null }, tDepth: { value: null }, texel: { value: new T.Vector2() }, cameraNear: aoU.cameraNear, cameraFar: aoU.cameraFar });
  const finU = { tScene: { value: null }, tB0: { value: null }, tB1: { value: null }, tB2: { value: null }, tAO: { value: null }, texel: { value: new T.Vector2() },
    bloom: { value: 0 }, aoOn: { value: 0 }, vignette: { value: 0 }, grade: { value: 0 }, exposure: { value: 1 }, post: { value: 0 } };
  let finM = null, finFx = null;
  const S = { rt: null, w: 0, h: 0, key: '', bloom: [], ao: null, aoTmp: null, aoW: 0, aoH: 0 };
  const black = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  const white = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
  const stats = { passes: 0 };

  const active = () => P.post || P.fxaa || (P.samples > 0 && (!nativeAA || P.samples > 4));
  const htype = () => (halfOK ? T.HalfFloatType : T.UnsignedByteType);
  const freeTargets = () => {
    S.rt?.depthTexture?.dispose(); S.rt?.dispose(); S.rt = null;
    for (const b of S.bloom) { b[0].dispose(); b[1].dispose(); }
    S.bloom = []; S.ao?.dispose(); S.aoTmp?.dispose(); S.ao = S.aoTmp = null; S.key = '';
  };
  function ensure(w, h) {
    const key = `${w}x${h}:${P.samples}:${P.post ? 1 : 0}:${P.ao}:${P.bloom > 0 ? 1 : 0}`;
    if (S.key === key) return;
    freeTargets();
    S.w = w; S.h = h; S.key = key;
    const needDepth = P.post && P.ao > 0;
    S.rt = new T.WebGLRenderTarget(w, h, { type: htype(), depthBuffer: true, stencilBuffer: false, samples: Math.min(P.samples, maxSamples) });
    S.rt.texture.minFilter = S.rt.texture.magFilter = T.LinearFilter; S.rt.texture.generateMipmaps = false;
    if (needDepth) { S.rt.depthTexture = new T.DepthTexture(w, h); S.rt.depthTexture.type = T.UnsignedIntType; }
    if (P.post && P.bloom > 0) {
      let bw = w, bh = h;
      for (let i = 0; i < 3; i++) {
        bw = Math.max(8, Math.round(bw / 2)); bh = Math.max(8, Math.round(bh / 2));
        const mk = () => { const r = new T.WebGLRenderTarget(bw, bh, { type: htype(), depthBuffer: false }); r.texture.minFilter = r.texture.magFilter = T.LinearFilter; r.texture.generateMipmaps = false; return r; };
        S.bloom.push([mk(), mk()]);
      }
    }
    if (needDepth) {
      const k = P.ao >= 2 ? 1 : 0.5;
      S.aoW = Math.max(8, Math.round(w * k)); S.aoH = Math.max(8, Math.round(h * k));
      const mk = () => new T.WebGLRenderTarget(S.aoW, S.aoH, { depthBuffer: false });
      S.ao = mk(); S.aoTmp = mk();
    }
  }
  const pass = (m, target) => { quad.material = m; renderer.setRenderTarget(target); renderer.render(qs, quadCam); stats.passes++; };
  function finalMat() {
    const fx = P.fxaa;
    if (!finM || finFx !== fx) { finM?.dispose(); finM = mat(FINAL_FRAG, finU, fx ? { FXAA: 1 } : {}); finFx = fx; }
    return finM;
  }
  function aoMat() {
    const n = P.ao >= 2 ? 16 : 8;
    if (!aoM || aoN !== n) { aoM?.dispose(); aoM = mat(AO_FRAG, aoU, { AO_N: n }); aoN = n; }
    return aoM;
  }

  return {
    get active() { return active(); },
    get samples() { return Math.min(P.samples, maxSamples); },
    get halfFloat() { return halfOK; },
    get maxSamples() { return maxSamples; },
    set(p = {}) {
      P.samples = Math.max(0, Number(p.samples) || 0);
      P.fxaa = !!p.fxaa; P.post = !!p.post;
      P.bloom = P.post ? Math.max(0, Number(p.bloom) || 0) : 0;
      P.ao = P.post ? Math.max(0, Math.round(Number(p.ao) || 0)) : 0;
      P.vignette = P.post ? Math.max(0, Number(p.vignette) || 0) : 0;
      P.grade = P.post ? Math.max(0, Number(p.grade) || 0) : 0;
      P.exposure = Number(p.exposure) || 1;
      if (!active()) freeTargets();
    },
    // Ana görüntü: etkin değilse doğrudan; etkinse sahne hedefi → (AO, bloom) → son geçiş ekrana. Çağıran ekran hedefinde (null) bırakılır.
    render(scene, camera) {
      if (!active()) { renderer.render(scene, camera); return false; }
      const w = renderer.domElement.width, h = renderer.domElement.height;
      ensure(w, h);
      renderer.setRenderTarget(S.rt); renderer.render(scene, camera);
      let aoTex = white;
      if (S.ao) {
        aoU.tDepth.value = S.rt.depthTexture; aoU.texel.value.set(1 / w, 1 / h);
        aoU.projInv.value.copy(camera.projectionMatrixInverse); aoU.proj.value.copy(camera.projectionMatrix);
        aoU.cameraNear.value = camera.near; aoU.cameraFar.value = camera.far;
        pass(aoMat(), S.ao);
        aoBlurM.uniforms.tAO.value = S.ao.texture; aoBlurM.uniforms.tDepth.value = S.rt.depthTexture; aoBlurM.uniforms.texel.value.set(1 / S.aoW, 1 / S.aoH);
        pass(aoBlurM, S.aoTmp);
        aoTex = S.aoTmp.texture;
      }
      const bt = [black, black, black];
      if (S.bloom.length) {
        let src = S.rt.texture, sw = w, sh = h;
        for (let i = 0; i < S.bloom.length; i++) {
          const [a, b] = S.bloom[i];
          if (i === 0) { brightM.uniforms.tSrc.value = src; brightM.uniforms.texel.value.set(0.5 / sw, 0.5 / sh); pass(brightM, a); }
          else { blurM.uniforms.tSrc.value = src; blurM.uniforms.dir.value.set(0, 0); pass(blurM, a); }   // küçültme (doğrusal örnekleme)
          blurM.uniforms.tSrc.value = a.texture; blurM.uniforms.dir.value.set(1 / a.width, 0); pass(blurM, b);
          blurM.uniforms.tSrc.value = b.texture; blurM.uniforms.dir.value.set(0, 1 / a.height); pass(blurM, a);
          bt[i] = a.texture; src = a.texture; sw = a.width; sh = a.height;
        }
      }
      finU.tScene.value = S.rt.texture; finU.tB0.value = bt[0]; finU.tB1.value = bt[1]; finU.tB2.value = bt[2]; finU.tAO.value = aoTex;
      finU.texel.value.set(1 / w, 1 / h); finU.bloom.value = P.bloom; finU.aoOn.value = S.ao ? 1 : 0; finU.vignette.value = P.vignette;
      finU.grade.value = P.grade; finU.exposure.value = P.exposure; finU.post.value = P.post ? 1 : 0;
      pass(finalMat(), null);
      return true;
    },
    info: () => ({ active: active(), samples: Math.min(P.samples, maxSamples), post: P.post, fxaa: P.fxaa, bloom: P.bloom, ao: P.ao, rt: S.rt ? [S.rt.width, S.rt.height] : null, aoRt: S.ao ? [S.aoW, S.aoH] : null, halfFloat: halfOK, passes: stats.passes }),
    dispose() { freeTargets(); for (const m of [brightM, blurM, aoBlurM, aoM, finM]) m?.dispose(); tri.dispose(); black.dispose(); white.dispose(); },
  };
}
